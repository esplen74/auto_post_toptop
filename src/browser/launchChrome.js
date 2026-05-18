import { chromium } from "playwright";

export async function launchChromeProfile({
  user,
  headless = false
}) {
  const context =
    await chromium.launchPersistentContext(
      user.chromeUserDataDir,
      {
        channel: "chrome",

        headless,

        viewport: null,

        locale: "vi-VN",

        ignoreDefaultArgs: [
          "--disable-extensions"
        ],

        args: [
          "--start-maximized",
          "--disable-blink-features=AutomationControlled"
        ]
      }
    );

  const page = await context.newPage();

  await page.goto(
  "https://www.tiktok.com/tiktokstudio/upload?from=creator_center&tab=video",
  {
    waitUntil: "domcontentloaded",
    timeout: 60000
  }
);

// Fast-path: check synchronously for the file input first to avoid extra delay.
const inputSelector = "input[type='file'][accept*='video']";
let fileInputHandle = await page.$(inputSelector);
if (!fileInputHandle) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(60);
    fileInputHandle = await page.$(inputSelector);
    if (fileInputHandle) {
      break;
    }
  }
}

if (!fileInputHandle) {
  // Very small fallback if the input is not immediately available.
  await page.waitForTimeout(100);
}

  return context;
}