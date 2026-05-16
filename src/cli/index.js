#!/usr/bin/env node

import { select, confirm } from "@inquirer/prompts";
import { loadConfig } from "../config/loadConfig.js";
import { createLogger } from "../logging/logger.js";
import { createSheetsClient } from "../google/sheetsClient.js";
import { VideoRepository } from "../google/videoRepository.js";
import { launchChromeProfile } from "../browser/launchChrome.js";
import { uploadVideo } from "../tiktok/uploader.js";
import { assertFileExists, resolveVideoPath } from "../utils/file.js";
import { retry } from "../utils/retry.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.rootDir);

  const userName = await select({
    message: "Chọn TikTok user để đăng video",
    choices: config.users.map((user) => ({
      name: user.name,
      value: user.name
    }))
  });

  const user = config.users.find((item) => item.name === userName);
  const shouldContinue = await confirm({
    message: config.dryRun
      ? `Đang ở DRY_RUN=true. Chạy thử với user ${user.name}?`
      : `Sẽ mở Chrome và đăng thật với user ${user.name}. Tiếp tục?`,
    default: config.dryRun
  });

  if (!shouldContinue) {
    logger.info("Cancelled by user");
    return;
  }

  const sheets = await createSheetsClient(config.googleCredentialsPath);
  const repository = new VideoRepository({
    sheets,
    spreadsheetId: config.googleSheetId,
    sheetName: user.sheetName
  });

  const videos = await repository.findPendingForUser(user.name, config.uploadLimitPerRun);
  logger.info(`Found ${videos.length} eligible videos for ${user.name}`);

  if (videos.length === 0) {
    return;
  }

  const context = await launchChromeProfile({
    user,
    headless: config.headless
  });

  try {
    for (const video of videos) {
      const videoPath = resolveVideoPath(config.videoRoot, video.video_path);
      logger.info(`Processing video ${video.ID}`, { videoPath });

      try {
        assertFileExists(videoPath);

        if (!config.dryRun) {
          await repository.markUploading(video.rowNumber);
        }

        const tiktokUrl = await retry(
          () =>
            uploadVideo({
              context,
              video,
              videoPath,
              logger,
              dryRun: config.dryRun,
              uploadUrl: config.tiktokUploadUrl
            }),
          {
            attempts: 2,
            delayMs: 3000,
            onRetry: (error, attempt) => {
              logger.warn(`Retrying ${video.ID} after attempt ${attempt}`, {
                error: error.message
              });
            }
          }
        );

        if (!config.dryRun) {
          await repository.markPosted(video.rowNumber, tiktokUrl);
        }
      } catch (error) {
        logger.error(`Failed video ${video.ID}: ${error.message}`);
        if (!config.dryRun) {
          await repository.markFailed(video.rowNumber);
        }
      }
    }
  } finally {
    await context.close();
    logger.info(`Log saved to ${logger.logFile}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
