import { selectors } from "./selectors.js";
import { sleep } from "../utils/retry.js";

const soundSelectors = {
  soundTabButton: "button[data-button-name='sounds']",
  favoritesTab: "button[aria-controls='panel-favorites']",
  favoriteAddButton: "#panel-favorites [role='listitem'] button[data-icon-only='true']",
  removeOriginalSoundButton: "button:has(span[data-icon='VolumeUp'])",
  uploadSuccessIndicator: "div.info-status.success:has-text('Đã tải lên')"
};

export async function uploadVideo({ context, video, videoPath, logger, dryRun, uploadUrl }) {
  // Reuse the page opened by launchChromeProfile instead of creating a new one
  const pages = context.pages();
  if (pages.length === 0) {
    throw new Error("No pages available in context");
  }
  
  const page = pages[pages.length - 1]; // Use the last (most recently opened) page
  
  logger.info(`Using existing page for ${video.ID}`);

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

  await sleep(2000);
  
  // Wait for upload success before proceeding to sound editing
  await waitForUploadSuccess(page, logger);
  
  // Edit sound: remove original and select random favorite
  await editSound(page, logger);

  await sleep(2000);
  
  // Save music selection
  await saveMusicSelection(page, logger);
  
  // Check for copyright and content violations
  const checksOk = await checkForViolations(page, logger);
  
  if (!checksOk) {
    logger.error(`❌ Video ${video.ID} has violations. Skipping post.`);
    return page.url();
  }

  await sleep(2000);
  
  // TEST MODE: Skip clicking post button to allow manual verification
  logger.info(`⚠️ TEST MODE: Ready to post but skipping Post button click for verification`);
  logger.info(`📸 Verify the video, caption, and sound selection before clicking Post manually`);
  
  // Uncomment the lines below to actually post:
  // await page.locator(selectors.postButton).first().click();
  // logger.info(`Clicked post button for ${video.ID}`);
  // await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
  
  return page.url();
}

async function waitForUploadSuccess(page, logger) {
  logger.info("Waiting for upload success indicator...");
  try {
    await page.waitForSelector(soundSelectors.uploadSuccessIndicator, {
      timeout: 60000
    });
    logger.info("Upload success indicator found.");
  } catch (error) {
    logger.warn(
      "Upload success indicator not found within 60 seconds. Proceeding to sound editing anyway.",
      { error: error.message }
    );
  }
}

async function editSound(page, logger) {
  logger.info("Opening sound tab...");

  const soundTab = page.locator(soundSelectors.soundTabButton).first();
  await soundTab.click();

  await page.waitForSelector("div.MusicPanelContainer__root", {
    timeout: 30000
  });
  logger.info("Sound panel opened.");

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await sleep(3000);

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
    logger.warn("Favorites tab not found with primary selectors. Trying fallback...", { error: error.message });
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

  await sleep(2000);

  const removeButton = page.locator(soundSelectors.removeOriginalSoundButton).first();
  if (await removeButton.isVisible()) {
    logger.info("Removing original sound...");
    await removeButton.click();
    await sleep(1500);
  } else {
    logger.info("Original sound button not visible; skipping.");
  }

  await page.waitForSelector(soundSelectors.favoriteAddButton, {
    timeout: 30000
  });

  // Get all favorite audio items - more specific selector to avoid duplicates
  const favoriteItems = page.locator("#panel-favorites [role='listitem']");
  const count = await favoriteItems.count();
  
  if (count === 0) {
    throw new Error("No favorite audio items found.");
  }

  const chosenIndex = Math.floor(Math.random() * count);
  logger.info(`Found ${count} favorite audio items, selecting index ${chosenIndex}`);
  
  // Click the add button within the chosen item - more precise
  const selectedItem = favoriteItems.nth(chosenIndex);
  const addButton = selectedItem.locator("button[data-icon-only='true']").first();
  
  await addButton.click();
  logger.info(`Selected favorite audio item index ${chosenIndex}.`);

  await sleep(2000);
  logger.info("Sound selection complete.");
}

async function saveMusicSelection(page, logger) {
  logger.info("Looking for Save button to confirm music selection...");
  
  try {
    // Wait a moment so the save button appears after music selection
    await sleep(500);
    // Find Save button - handle both English and Vietnamese ("Save", "Lưu")
    const saveButton = page.locator("button:has-text('Lưu'), button:has-text('Save')").first();
    
    if (await saveButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await saveButton.scrollIntoViewIfNeeded();
      await saveButton.click();
      logger.info("Clicked Save/Lưu button.");
      await sleep(500);
    } else {
      logger.warn("Save button not visible; checking if auto-saved...");
      // Sometimes music is auto-saved, wait a bit and check
      await sleep(500);
    }
  } catch (error) {
    logger.warn("Error finding Save button", { error: error.message });
  }
}

async function checkForViolations(page, logger) {
  logger.info("Checking for copyright and content violations...");
  
  try {
    // After saving music selection, the page often reloads back to the upload view
    // and performs background checks. Wait for navigation/idle then poll the
    // page text to detect either a "checking" state or final results (Vietnamese/English).
    try {
      await page.waitForNavigation({ waitUntil: "networkidle", timeout: 10000 });
    } catch (_) {
      // navigation may not happen; continue
    }

    const CHECK_TIMEOUT_MS = 60000;
    const POLL_INTERVAL_MS = 1000;
    const start = Date.now();

    const checkingPhrases = ["Đang kiểm tra", "Checking", "Checking for", "Đang kiểm tra."]; 
    const okPhrases = [
      "Không phát hiện vấn đề nào", // Vietnamese: No issues found
      "No issues found",
      "No issues detected"
    ];

    while (Date.now() - start < CHECK_TIMEOUT_MS) {
      // First prefer checking DOM status elements if available.
      const successCount = await page.locator(".status-result.status-success .status-tip").count().catch(() => 0);
      const warnCount = await page.locator(".status-result.status-warn .status-tip").count().catch(() => 0);
      const errorCount = await page.locator(".status-result.status-error .status-tip").count().catch(() => 0);

      if (successCount >= 2) {
        logger.info("✓ Both copyright and content checks passed - no issues found (DOM)");
        return true;
      }

      if (warnCount > 0 || errorCount > 0) {
        logger.error("✗ Detected restriction/warning/error in status elements");
        return false;
      }

      // Fallback to text scanning: if still checking, continue polling
      const bodyText = await page.evaluate(() => document.body.innerText || "");
      const normalized = (bodyText || "").toLowerCase();

      if (checkingPhrases.some((p) => normalized.includes(p.toLowerCase()))) {
        logger.info("Background checks in progress...");
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Fallback: Count OK phrases in text (both checks should show OK)
      let okCount = 0;
      for (const phrase of okPhrases) {
        okCount += (bodyText.match(new RegExp(phrase, "gi")) || []).length;
      }
      if (okCount >= 2) {
        logger.info("✓ Both copyright and content checks passed - no issues found (text)");
        return true;
      }

      // If any other indicative word appears, fail
      const failPhrases = ["hạn chế", "restricted", "lỗi", "error", "vi phạm", "violation"];
      if (failPhrases.some((p) => normalized.includes(p.toLowerCase()))) {
        logger.error("✗ Detected restriction or violation in page text (fallback)");
        return false;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    logger.warn("Timeout waiting for content/music checks to complete - treating as failed");
    return false;
    
  } catch (error) {
    logger.error("Error during violation check", { error: error.message });
    return false;
  }
}

