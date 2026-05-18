#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
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

  const sheets = await createSheetsClient(config.googleCredentialsPath);
  const repository = new VideoRepository({
    sheets,
    spreadsheetId: config.googleSheetId,
    sheetName: config.users[0].sheetName,
    logger
  });

  // Process videos one-at-a-time to ensure a single failing row does not abort other rows.
  const limit = Number(config.uploadLimitPerRun || 3);
  let processed = 0;

  while (processed < limit) {
    const items = await repository.findPending(1);
    if (!items || items.length === 0) {
      logger.info("No more pending videos to process.");
      break;
    }

    const video = items[0];
    const userKey = (video.user || "").toString().trim();
    if (!userKey) {
      logger.warn(`Skipping row ${video.rowNumber} because user column is empty`);
      if (!config.dryRun) {
        await repository.markFailed(video.rowNumber);
      }
      processed += 1;
      continue;
    }

    const explicitUser = config.users.find((u) => path.basename(u.chromeUserDataDir) === userKey);
    const chromeUserDataDir = explicitUser
      ? explicitUser.chromeUserDataDir
      : path.resolve(config.commonProfilesDir, userKey);

    // If the profile directory does not exist, treat as an error per user's request.
    if (!fs.existsSync(chromeUserDataDir)) {
      logger.error(`Profile not found for user ${userKey}: ${chromeUserDataDir}`);
      if (!config.dryRun) {
        await repository.markFailed(video.rowNumber);
      }
      processed += 1;
      continue;
    }

    const profile = { name: userKey, chromeUserDataDir };
    const context = await launchChromeProfile({ user: profile, headless: config.headless });

    try {
      // After launch, ensure navigation didn't redirect to login. If accessing the upload URL
      // requires login (redirect), treat as error. Otherwise proceed.
      const pages = context.pages();
      const page = pages.find((p) => p.url().includes("tiktok")) || pages[pages.length - 1];

      try {
        await page.waitForLoadState("networkidle", { timeout: 10000 });
      } catch (_) {
        // ignore timeout and continue to check URL
      }

      const finalUrl = page.url();
      const loginPattern = /login|signin|auth|accounts|authorize|appleid|oauth|challenge/i;
      if (loginPattern.test(finalUrl)) {
        logger.error(`Profile ${userKey} was redirected to login page ${finalUrl}`);
        if (!config.dryRun) {
          await repository.markFailed(video.rowNumber);
        }
        await context.close();
        processed += 1;
        continue;
      }

      const videoPath = resolveVideoPath(config.videoRoot, video.video_path);
      logger.info(`Processing video ${video.ID} for user ${userKey}`, { videoPath });

      try {
        assertFileExists(videoPath);

        if (!config.dryRun) {
          await repository.markUploading(video.rowNumber);
        }

        const result = await retry(
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
          if (result && result.success) {
            await repository.markPosted(video.rowNumber, result.note);
          } else {
            await repository.markFailed(video.rowNumber, result ? result.note : "");
          }
        }
      } catch (error) {
        logger.error(`Failed video ${video.ID}: ${error.message}`);
        if (!config.dryRun) {
          await repository.markFailed(video.rowNumber);
        }
      }
    } finally {
      await context.close();
      logger.info(`Log saved to ${logger.logFile}`);
    }

    processed += 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});