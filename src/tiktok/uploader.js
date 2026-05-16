import { selectors } from "./selectors.js";
import { sleep } from "../utils/retry.js";

export async function uploadVideo({ context, video, videoPath, logger, dryRun, uploadUrl }) {
  const page = context.pages()[0] || (await context.newPage());

  logger.info(`Opening TikTok upload page for ${video.ID}`);
  await page.goto(uploadUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  logger.info(`TikTok page loaded: ${page.url()}`);

  if (dryRun) {
    logger.info(`Dry run: would upload ${videoPath}`);
    return "";
  }

  await page.setInputFiles(selectors.fileInput, videoPath);
  logger.info(`Selected video file for ${video.ID}`);

  if (video.caption) {
    await page.locator(selectors.captionEditor).first().click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(video.caption, { delay: 20 });
    logger.info(`Filled caption for ${video.ID}`);
  }

  await sleep(3000);
  await page.locator(selectors.postButton).first().click();
  logger.info(`Clicked post button for ${video.ID}`);

  await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
  return page.url();
}
