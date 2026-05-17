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

// Fast-path: check synchronously for the file input first to avoid waitForSelector delays.
const fileInputHandle = await page.$("input[type='file'][accept*='video']");
if (!fileInputHandle) {
  try {
    // Wait briefly for the input to appear (short timeout)
    await page.waitForSelector("input[type='file'][accept*='video']", { state: 'attached', timeout: 800 });
  } catch (_) {
    // Final fallback: tiny delay so page can settle
    await page.waitForTimeout(200);
  }
}

  return context;
}