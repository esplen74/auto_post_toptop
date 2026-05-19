#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { loadConfig } from "../config/loadConfig.js";
import { createLogger } from "../logging/logger.js";
import { createSheetsClient } from "../google/sheetsClient.js";
import { VideoRepository } from "../google/videoRepository.js";

const __filename = fileURLToPath(import.meta.url);

const LINK_HEADER_CANDIDATES = [
  "Link tiktok Douyin",
  "link_tiktok_douyin",
  "douyin_link",
  "tiktok_douyin_link",
  "douyin"
];

const LINK_REGEX = /https:\/\/v\.douyin\.com\/[a-zA-Z0-9_-]+\/?/g;
const SAVETIK_URL = "https://savetik.io/en/douyin-video-downloader";
const DEFAULT_DOWNLOAD_PROFILE = "/Users/lphee98/Auto_TopTop/chrome-profiles/auto-download";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.rootDir);

  const requestedProfile = getFlagValue("--profile=") || process.env.DOWNLOAD_PROFILE_PATH || DEFAULT_DOWNLOAD_PROFILE;
  const maxRows = Number(getFlagValue("--limit=") || getFlagValue("--max=") || process.env.DOWNLOAD_LIMIT || 0);

  await downloadPendingVideos({ config, logger, requestedProfile, maxRows });
}

export async function downloadPendingVideos({ config, logger, requestedProfile = DEFAULT_DOWNLOAD_PROFILE, maxRows = 0 }) {
  const profile = {
    name: "auto-download",
    chromeUserDataDir: resolveProfilePath(requestedProfile, config.rootDir)
  };

  if (!fs.existsSync(profile.chromeUserDataDir)) {
    throw new Error(`Profile download không tồn tại: ${profile.chromeUserDataDir}`);
  }

  logger.info(`Using download profile: ${profile.chromeUserDataDir}`);

  const sheets = await createSheetsClient(config.googleCredentialsPath);
  const repository = new VideoRepository({
    sheets,
    spreadsheetId: config.googleSheetId,
    sheetName: config.users[0].sheetName,
    logger
  });

  const rows = await repository.listRows();
  const linkKey = detectLinkHeader(rows);
  if (!linkKey) {
    throw new Error(
      `Không tìm thấy cột chứa link Douyin. Vui lòng thêm một cột với tiêu đề trong: ${LINK_HEADER_CANDIDATES.join(", ")}`
    );
  }

  const candidates = rows.filter((row) => {
    const linkValue = String(row[linkKey] || "").trim();
    return (
      linkValue &&
      !String(row.video_path || "").trim() 
    );
  });

  if (candidates.length === 0) {
    logger.info("Không có hàng Douyin cần download. Kiểm tra lại cột link và video_path.");
    return;
  }

  const candidatesToProcess = maxRows > 0 ? candidates.slice(0, maxRows) : candidates;
  logger.info(`Sẽ xử lý ${candidatesToProcess.length}/${candidates.length} hàng Douyin.`);

  await ensureDirectory(config.videoRoot);

  const context = await chromium.launchPersistentContext(profile.chromeUserDataDir, {
    channel: "chrome",
    headless: false,
    viewport: null,
    locale: "vi-VN",
    acceptDownloads: true,
    downloadsPath: path.resolve(config.rootDir, "downloads"),
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"]
  });

  const page = await context.newPage();

  try {
    logger.info(`Mở trang downloader: ${SAVETIK_URL}`);
    await page.goto(SAVETIK_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("#s_input", { timeout: 30000 });

    for (const row of candidatesToProcess) {
      const rawValue = String(row[linkKey] || "").trim();
      const douyinLink = extractDouyinLink(rawValue);

      if (!douyinLink) {
        logger.warn(`Bỏ qua hàng ${row.rowNumber}: không tìm thấy link Douyin hợp lệ.`);
        continue;
      }

      logger.info(`(${row.rowNumber}) Download: ${douyinLink}`);

      try {
        const downloadedFile = await downloadDouyinVideo(page, douyinLink, config.videoRoot, logger);

        if (downloadedFile) {
          const relativePath = path.relative(config.videoRoot, downloadedFile);
          await repository.updateCells(row.rowNumber, {
            video_path: relativePath
          });
          logger.info(`✅ Hàng ${row.rowNumber} đã download và đặt video_path=${relativePath}`);
        } else {
          logger.warn(`❌ Hàng ${row.rowNumber} không download được sau các lần thử.`);
        }
      } catch (error) {
        logger.error(`⚠️ Lỗi hàng ${row.rowNumber}: ${error.message}`);
      }

      await page.waitForTimeout(1500);
    }

    logger.info("Hoàn tất download Douyin.");
  } finally {
    await context.close();
  }
}

function getFlagValue(prefix) {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function resolveProfilePath(profilePath, rootDir) {
  return path.isAbsolute(profilePath) ? profilePath : path.resolve(rootDir, profilePath);
}

function normalizeUserKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function findUser(users, requestedUser) {
  if (!requestedUser) {
    return users.find((user) => normalizeUserKey(user.name) === "auto_download");
  }

  const normalizedRequest = normalizeUserKey(requestedUser);
  return users.find((user) => {
    const aliases = Array.isArray(user.aliases) ? user.aliases : [];
    const keys = [user.name, ...aliases].map(normalizeUserKey);
    return keys.includes(normalizedRequest);
  });
}

function detectLinkHeader(rows) {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return headers.find((header) =>
    LINK_HEADER_CANDIDATES.some((candidate) => normalizeUserKey(header) === normalizeUserKey(candidate))
  );
}

function extractDouyinLink(raw) {
  const matches = raw.match(LINK_REGEX);
  return matches && matches.length > 0 ? matches[0] : null;
}

function isPendingStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized !== "done" && normalized !== "error";
}

async function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function downloadDouyinVideo(page, link, downloadRoot, logger) {
  const MAX_ATTEMPTS = 5;
  
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    logger.info(`  Attempt ${attempt}/${MAX_ATTEMPTS}: processing ${link}`);
    
    // Clear and fill input
    await page.evaluate((link) => {
      const input = document.querySelector("#s_input");
      if (!input) {
        throw new Error("Không tìm thấy ô input #s_input");
      }
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, link);

    await page.waitForTimeout(600);

    await page.evaluate((link) => {
      const input = document.querySelector("#s_input");
      input.value = link;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, link);

    await page.waitForTimeout(800);

    const hasDownloader = await page.evaluate(() => typeof window.ksearchvideo === "function");
    if (!hasDownloader) {
      throw new Error("Hàm ksearchvideo không tồn tại trên trang.");
    }

    await page.evaluate(() => window.ksearchvideo());
    await page.waitForTimeout(6000); // Increased: button needs more time to appear

    const buttons = await page.$$(".tik-button-dl");
    if (!buttons || buttons.length === 0) {
      logger.info(`  → No download button found, retrying...`);
      await page.waitForTimeout(4000);
      continue;
    }

    let target = buttons[0];
    for (const button of buttons) {
      const inner = await button.innerText();
      if (inner.includes("HD")) {
        target = button;
        break;
      }
    }

    logger.info(`  → Found download button, clicking...`);
    
    const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
    await target.click();
    
    let download = null;
    try {
      download = await downloadPromise;
      logger.info(`  → Download started successfully`);
    } catch (error) {
      logger.warn(`  → Download event timeout, waiting longer...`);
      await page.waitForTimeout(8000); // Extra wait for download to start
      
      // Try to detect if download has started by other means
      try {
        download = await page.waitForEvent("download", { timeout: 15000 });
        logger.info(`  → Download detected in secondary wait`);
      } catch (_) {
        logger.info(`  → Still no download, will retry link`);
        await page.waitForTimeout(4000);
        continue;
      }
    }

    if (!download) {
      logger.warn(`  → No download event received, retrying...`);
      await page.waitForTimeout(4000);
      continue;
    }

    const suggestedFileName = download.suggestedFilename();
    const saveName = sanitizeFilename(suggestedFileName || `douyin-${Date.now()}.mp4`);
    const savePath = path.join(downloadRoot, saveName);
    
    try {
      await download.saveAs(savePath);
      logger.info(`✅ Successfully downloaded: ${saveName}`);
      await page.waitForTimeout(6000); // Wait between links to avoid server overload
      return savePath;
    } catch (saveError) {
      logger.error(`  → Failed to save file: ${saveError.message}`);
      await page.waitForTimeout(4000);
      continue;
    }
  }

  logger.error(`❌ Failed after ${MAX_ATTEMPTS} attempts`);
  return null;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
