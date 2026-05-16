#!/usr/bin/env node

import { select, confirm } from "@inquirer/prompts";
import { loadConfig } from "../config/loadConfig.js";
import { createLogger } from "../logging/logger.js";
import { launchChromeProfile } from "../browser/launchChrome.js";

const WAIT_AFTER_OPEN_MS = 8000;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.rootDir);
  const requestedUser = getRequestedUser();

  const user = requestedUser
    ? findUser(config.users, requestedUser)
    : await selectUser(config.users);

  if (!user) {
    throw new Error(`Cannot find user: ${requestedUser}`);
  }

  logger.info(`Inspecting upload UI with user ${user.name}`, {
    chromeUserDataDir: user.chromeUserDataDir
  });

  const context = await launchChromeProfile({
    user,
    headless: false
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    logger.info(`Opening ${config.tiktokUploadUrl}`);
    await page.goto(config.tiktokUploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(WAIT_AFTER_OPEN_MS);

    const report = await inspectPage(page);
    printReport(report);

    const keepOpen = await confirm({
      message: "Giữ Chrome mở để bạn nhìn UI thêm?",
      default: true
    });

    if (keepOpen) {
      await confirm({
        message: "Khi xem xong, quay lại terminal và bấm Enter để đóng Chrome.",
        default: true
      });
    }
  } finally {
    await context.close();
  }
}

async function selectUser(users) {
  const userName = await select({
    message: "Chọn TikTok user để inspect upload UI",
    choices: users.map((user) => ({
      name: user.name,
      value: user.name
    }))
  });

  return users.find((item) => item.name === userName);
}

function getRequestedUser() {
  const arg = process.argv.find((item) => item.startsWith("--user="));
  if (arg) {
    return arg.slice("--user=".length);
  }

  return process.env.TIKTOK_USER || "";
}

function findUser(users, requestedUser) {
  const normalizedRequest = normalizeUserKey(requestedUser);

  return users.find((user) => {
    const keys = [user.name, ...(user.aliases || [])].map(normalizeUserKey);
    return keys.includes(normalizedRequest);
  });
}

function normalizeUserKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function inspectPage(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const unique = (items) => [...new Set(items.filter(Boolean))];

    const inputs = [...document.querySelectorAll("input")].map((input, index) => ({
      index,
      type: input.getAttribute("type") || "",
      accept: input.getAttribute("accept") || "",
      name: input.getAttribute("name") || "",
      ariaLabel: input.getAttribute("aria-label") || "",
      hidden: input.hidden || input.offsetParent === null
    }));

    const textareas = [...document.querySelectorAll("textarea")].map((textarea, index) => ({
      index,
      placeholder: textarea.getAttribute("placeholder") || "",
      ariaLabel: textarea.getAttribute("aria-label") || "",
      text: clean(textarea.value)
    }));

    const contentEditables = [...document.querySelectorAll("[contenteditable='true']")].map(
      (node, index) => ({
        index,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role") || "",
        ariaLabel: node.getAttribute("aria-label") || "",
        text: clean(node.textContent).slice(0, 160)
      })
    );

    const buttons = [...document.querySelectorAll("button, [role='button']")]
      .map((button, index) => ({
        index,
        tag: button.tagName.toLowerCase(),
        text: clean(button.innerText || button.textContent).slice(0, 120),
        ariaLabel: button.getAttribute("aria-label") || "",
        disabled:
          button.disabled ||
          button.getAttribute("aria-disabled") === "true" ||
          button.getAttribute("disabled") !== null
      }))
      .filter((button) => button.text || button.ariaLabel);

    const labels = unique(
      [...document.querySelectorAll("label, [role='checkbox'], [role='radio']")]
        .map((node) => clean(node.innerText || node.textContent).slice(0, 120))
        .filter(Boolean)
    ).slice(0, 80);

    const bodyText = clean(document.body.innerText);
    const keywords = [
      "copyright",
      "bản quyền",
      "vi phạm",
      "originality",
      "check",
      "scheduled",
      "schedule",
      "lên lịch",
      "post",
      "đăng",
      "upload",
      "tải lên",
      "sound",
      "music",
      "nhạc"
    ];

    const keywordMatches = keywords
      .filter((keyword) => bodyText.toLowerCase().includes(keyword.toLowerCase()))
      .map((keyword) => {
        const lower = bodyText.toLowerCase();
        const index = lower.indexOf(keyword.toLowerCase());
        return bodyText.slice(Math.max(0, index - 80), index + 180);
      });

    return {
      url: location.href,
      title: document.title,
      inputCount: inputs.length,
      fileInputs: inputs.filter((input) => input.type === "file"),
      textareas,
      contentEditables,
      buttons: buttons.slice(0, 120),
      labels,
      keywordMatches: unique(keywordMatches).slice(0, 20)
    };
  });
}

function printReport(report) {
  console.log("\n=== TikTok Upload UI Inspect ===");
  console.log(`URL: ${report.url}`);
  console.log(`Title: ${report.title}`);
  console.log(`Input count: ${report.inputCount}`);

  console.log("\nFile inputs:");
  console.table(report.fileInputs);

  console.log("\nTextareas:");
  console.table(report.textareas);

  console.log("\nContenteditable candidates:");
  console.table(report.contentEditables);

  console.log("\nButtons:");
  console.table(report.buttons);

  console.log("\nCheckbox/radio/label text:");
  for (const label of report.labels) {
    console.log(`- ${label}`);
  }

  console.log("\nKeyword snippets:");
  for (const snippet of report.keywordMatches) {
    console.log(`- ${snippet}`);
  }
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
