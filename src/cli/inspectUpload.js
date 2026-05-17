#!/usr/bin/env node

// NOTE: `inspectUpload.js` is a developer/test utility to inspect the
// TikTok Studio upload UI. It is not part of the production upload
// flow — use `src/cli/index.js` (or refactored modules) for automated runs.

import { select, confirm } from "@inquirer/prompts";
import { loadConfig } from "../config/loadConfig.js";
import { createLogger } from "../logging/logger.js";
import { launchChromeProfile } from "../browser/launchChrome.js";
import { resolveVideoPath, assertFileExists } from "../utils/file.js";

const soundSelectors = {
  soundTabButton: "button[data-button-name='sounds']",
  favoritesTab: "button[aria-controls='panel-favorites']",
  favoriteAddButton: "#panel-favorites [role='listitem'] button[data-icon-only='true']",
  removeOriginalSoundButton: "button:has(span[data-icon='VolumeUp'])"
};

const uploadSuccessSelector = "div.info-status.success:has-text('Đã tải lên')";

const WAIT_AFTER_UPLOAD_MS = 15000;

// VIDEO TEST: use project config/videoRoot and optional env TEST_VIDEO

async function main() {
  const config = loadConfig();

  const logger = createLogger(config.rootDir);

  const requestedUser = getRequestedUser();

  const user = requestedUser
    ? findUser(config.users, requestedUser)
    : await selectUser(config.users);

  if (!user) {
    throw new Error(
      `Cannot find user: ${requestedUser}`
    );
  }

  logger.info(
    `Inspecting upload UI with user ${user.name}`,
    {
      chromeUserDataDir:
        user.chromeUserDataDir
    }
  );

  const context =
    await launchChromeProfile({
      user,
      headless: false
    });

  try {
    const page = await context.newPage();

    logger.info(
      `Opening ${config.tiktokUploadUrl}`
    );

    await page.goto(
      config.tiktokUploadUrl,
      {
        waitUntil: "domcontentloaded",
        timeout: 60000
      }
    );

    // Đợi TikTok render
    await page.waitForTimeout(5000);

    console.log(
      "\n=== FIND FILE INPUT ==="
    );

    await page.waitForSelector(
      'input[type="file"][accept*="video"]',
      {
        timeout: 30000,
        state: "attached"
      }
    );

    const fileInput = page.locator(
      'input[type="file"][accept*="video"]'
    );

    const count =
      await fileInput.count();

    console.log(
      "Found file input:",
      count
    );

    if (!count) {
      throw new Error(
        "Cannot find file input."
      );
    }

    console.log(
      "Uploading test video..."
    );

    const testVideo = resolveVideoPath(
      config.videoRoot,
      process.env.TEST_VIDEO || "test.mp4"
    );

    // ensure test file exists before attempting upload
    try {
      assertFileExists(testVideo);
    } catch (err) {
      console.error(`Test video not found: ${testVideo}`);
      throw err;
    }

    await fileInput.setInputFiles(testVideo, { timeout: 60000 });

    console.log(
      "Video uploaded."
    );
    
      await waitForUploadSuccess(page, logger);
      await page.waitForTimeout(3000);

    await openSoundPanelAndAddFavorite(page, logger);

    console.log(
      `Waiting ${WAIT_AFTER_UPLOAD_MS}ms...`
    );

    await page.waitForTimeout(
      WAIT_AFTER_UPLOAD_MS
    );

    const report =
      await inspectPage(page);

    printReport(report);

    const keepOpen = await confirm({
      message:
        "Giữ Chrome mở để inspect thêm?",
      default: true
    });

    if (keepOpen) {
      await confirm({
        message:
          "Khi xem xong quay lại terminal và bấm Enter để đóng.",
        default: true
      });
    }
  } finally {
    await context.close();
  }
}

async function selectUser(users) {
  const userName = await select({
    message:
      "Chọn TikTok user để inspect upload UI",

    choices: users.map((user) => ({
      name: user.name,
      value: user.name
    }))
  });

  return users.find(
    (item) => item.name === userName
  );
}

function getRequestedUser() {
  const arg = process.argv.find(
    (item) =>
      item.startsWith("--user=")
  );

  if (arg) {
    return arg.slice(
      "--user=".length
    );
  }

  return (
    process.env.TIKTOK_USER || ""
  );
}

function findUser(
  users,
  requestedUser
) {
  const normalizedRequest =
    normalizeUserKey(
      requestedUser
    );

  return users.find((user) => {
    const keys = [
      user.name,
      ...(user.aliases || [])
    ].map(normalizeUserKey);

    return keys.includes(
      normalizedRequest
    );
  });
}

function normalizeUserKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "_"
    )
    .replace(/^_+|_+$/g, "");
}

async function inspectPage(page) {
  return page.evaluate(() => {
    const clean = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    const buttons = [
      ...document.querySelectorAll(
        "button, [role='button']"
      )
    ]
      .map((button, index) => ({
        index,

        text: clean(
          button.innerText ||
            button.textContent
        ).slice(0, 120),

        disabled:
          button.disabled ||
          button.getAttribute(
            "aria-disabled"
          ) === "true"
      }))
      .filter(
        (button) => button.text
      );

    const contentEditables = [
      ...document.querySelectorAll(
        "[contenteditable='true']"
      )
    ].map((node, index) => ({
      index,

      text: clean(
        node.textContent
      ).slice(0, 200)
    }));

    const bodyText = clean(
      document.body.innerText
    );

    const hasRestrictionWarning =
      bodyText.includes(
        "Nội dung có thể sẽ bị hạn chế"
      );

    const hasNoCopyrightIssue =
      bodyText.includes(
        "Không phát hiện vấn đề nào"
      );

    const hasPostButtonEnabled =
      buttons.some(
        (button) =>
          button.text === "Đăng" &&
          !button.disabled
      );

    const canAutoPost =
      hasNoCopyrightIssue &&
      !hasRestrictionWarning &&
      hasPostButtonEnabled;

    return {
      url: location.href,

      title: document.title,

      buttons,

      contentEditables,

      hasRestrictionWarning,

      hasNoCopyrightIssue,

      hasPostButtonEnabled,

      canAutoPost
    };
  });
}

function printReport(report) {
  console.log(
    "\n=== AFTER UPLOAD REPORT ==="
  );

  console.log(
    `URL: ${report.url}`
  );

  console.log(
    `Title: ${report.title}`
  );

  console.log(
    "\nContenteditable:"
  );

  console.table(
    report.contentEditables
  );

  console.log("\nButtons:");

  console.table(report.buttons);

  console.log(
    "\nRestriction warning:",
    report.hasRestrictionWarning
  );

  console.log(
    "No copyright issue:",
    report.hasNoCopyrightIssue
  );

  console.log(
    "Post enabled:",
    report.hasPostButtonEnabled
  );

  console.log(
    "Can auto post:",
    report.canAutoPost
  );
}

async function openSoundPanelAndAddFavorite(page, logger) {
  logger.info("Opening sound tab...");

  const soundTab = page.locator(soundSelectors.soundTabButton).first();
  await soundTab.click();

  await page.waitForSelector("div.MusicPanelContainer__root", {
    timeout: 30000
  });
  logger.info("Sound panel opened.");

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(4000);

  logger.info("Waiting for Favorites tab...");
  
  // Try to find Favorites tab by aria-controls or by text (handle both English and Vietnamese)
  const favoritesTabByAriaControls = page.locator("button[aria-controls='panel-favorites']").first();
  const favoritesTabByText = page.locator("button[role='tab']:has-text('Favorites|yêu thích')").first();
  
  let favoritesTab = await favoritesTabByAriaControls.isVisible() 
    ? favoritesTabByAriaControls 
    : favoritesTabByText;

  try {
    await favoritesTab.waitFor({ state: "visible", timeout: 15000 });
  } catch (error) {
    logger.error("Favorites tab not found. Trying alternative selector...", { error: error.message });
    // Fallback: find any tab that contains "Favorites" or "yêu thích"
    const allTabs = page.locator("button[role='tab']");
    const tabCount = await allTabs.count();
    let found = false;
    for (let i = 0; i < tabCount; i++) {
      const tabText = await allTabs.nth(i).textContent();
      if (tabText && (tabText.includes("Favorites") || tabText.includes("yêu thích"))) {
        favoritesTab = allTabs.nth(i);
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error("Favorites tab not found with any selector.");
    }
  }

  if (!(await favoritesTab.isVisible())) {
    throw new Error("Favorites tab is not visible after opening sound panel.");
  }

  await favoritesTab.click();
  logger.info("Selected Favorites tab.");

  await page.waitForTimeout(3000);

  const removeButton = page.locator(soundSelectors.removeOriginalSoundButton).first();
  if (await removeButton.isVisible()) {
    logger.info("Removing original sound...");
    await removeButton.click();
    await page.waitForTimeout(1500);
  } else {
    logger.info("Original sound button not visible; skipping.");
  }

  await page.waitForSelector(soundSelectors.favoriteAddButton, {
    timeout: 30000
  });

  const favoriteButtons = page.locator(soundSelectors.favoriteAddButton);
  const count = await favoriteButtons.count();
  if (count === 0) {
    throw new Error("No favorite audio items found.");
  }

  const chosenIndex = Math.floor(Math.random() * count);
  await favoriteButtons.nth(chosenIndex).click();
  logger.info(`Selected favorite audio item index ${chosenIndex}.`);

  await page.waitForTimeout(2000);
  logger.info("Sound selection complete.");
}

async function waitForUploadSuccess(page, logger) {
  logger.info("Waiting for upload success indicator...");
  try {
    await page.waitForSelector(uploadSuccessSelector, {
      timeout: 60000
    });
    logger.info("Upload success indicator found.");
  } catch (error) {
    logger.warn(
      "Upload success indicator not found within 60 seconds. Proceeding to sound panel anyway.",
      { error: error.message }
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});