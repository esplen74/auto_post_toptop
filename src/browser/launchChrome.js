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

await page.waitForTimeout(5000);

  return context;
}