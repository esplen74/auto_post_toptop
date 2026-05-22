import { selectors } from "./selectors.js";
import { sleep } from "../utils/retry.js";

const soundSelectors = {
  soundTabButton: "button[data-button-name='sounds']",
  favoritesTab: "button[aria-controls='panel-favorites']",
  favoriteAddButton: "#panel-favorites [role='listitem'] button[data-icon-only='true']",
  removeOriginalSoundButton: "button:has(span[data-icon='VolumeUp'])",
  uploadSuccessIndicator: "div.info-status.success:has-text('Đã tải lên')"
};

export async function uploadVideo({ context, video, videoPath, logger, dryRun, uploadUrl, user }) {
  // Reuse the page opened by launchChromeProfile instead of creating a new one
  const pages = context.pages();
  if (pages.length === 0) {
    throw new Error("No pages available in context");
  }
  
  const page = pages[pages.length - 1]; // Use the last (most recently opened) page
  
  logger.info(`Using existing page for ${video.ID}`);

  if (dryRun) {
    logger.info(`Dry run: would upload ${videoPath}`);
    return { success: true, note: "dry-run" };
  }

  await page.setInputFiles(selectors.fileInput, videoPath);
  logger.info(`Selected video file for ${video.ID}`);

  const captionText = buildCaptionWithProfileHashtags(video.caption, user);
  if (captionText) {
    const captionLocator = page.locator(selectors.captionEditor).first();
    await captionLocator.waitFor({ state: "visible", timeout: 10000 });
    await captionLocator.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(captionText, { delay: 20 });
    logger.info(`Filled caption for ${video.ID}`);
    // After typing caption, prefer selecting hashtags from the caption history
    await clickHashtagHistory(page, logger).catch(() => {});
  }

  await sleep(2000);
  
  // Wait for upload success before proceeding to sound editing
  await waitForUploadSuccess(page, logger);
  
  // Edit sound: remove original and select random favorite
  await editSound(page, logger);

  await sleep(2000);
  
  // Save music selection
  await saveMusicSelection(page, logger);

  // Scheduling: if `video.scheduled_at` provided (format dd/MM/YYYY HH:mm:ss), select "Schedule" and set date/time
  if (video && video.scheduled_at) {
    const scheduledAtRaw = String(video.scheduled_at).trim();
    logger.info(`Scheduling requested: ${scheduledAtRaw}`);
    // Accept both dd/MM/YYYY HH:mm[:ss] and YYYY-MM-DD HH:mm[:ss]
    const m1 = scheduledAtRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const m2 = scheduledAtRaw.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    let isoDate = null;
    let timeStr = null;
    if (m1) {
      const [, day, month, year, hour, minute, second] = m1;
      isoDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      timeStr = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    } else if (m2) {
      const [, year, month, day, hour, minute, second] = m2;
      isoDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      timeStr = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    }

    // We'll attempt to set the exact date/time from the sheet below.
    // If the upload UI adjusts/overwrites the values after we set them,
    // we'll detect that and accept the upload page's final values (do not compensate).

    if (isoDate && timeStr) {
      // Try to click the schedule radio via the schedule container using JS click to avoid automatic scroll
      let scheduleClicked = false;
      const container = page.locator('div.schedule-radio-container');
      const containerCount = await container.count();
      logger.info(`Schedule radio container elements found: ${containerCount}`);

      if (containerCount > 0) {
        const scheduleInput = container.locator("input[name='postSchedule'][value='schedule']").first();
        const scheduleInputCount = await scheduleInput.count();
        logger.info(`Schedule input elements found: ${scheduleInputCount}`);

        if (scheduleInputCount > 0) {
          try {
            await scheduleInput.evaluate((el) => el.click());
            scheduleClicked = true;
          } catch (err) {
            logger.warn('Failed to click schedule input via evaluate()', { error: err.message });
          }
        }

        if (!scheduleClicked) {
          const scheduleLabel = container.locator('label').nth(1);
          const labelCount = await scheduleLabel.count();
          logger.info(`Schedule label elements found: ${labelCount}`);
          if (labelCount > 0) {
            await scheduleLabel.evaluate((el) => el.click()).catch(() => {});
            scheduleClicked = true;
          }
        }
      }

      logger.info(`Schedule radio clicked: ${scheduleClicked}`);
      // Verify checked state if radio exists
      let radioChecked = false;
      try {
        const scheduleInput = page.locator("input[name='postSchedule'][value='schedule']").first();
        radioChecked = await scheduleInput.evaluate(
          (el) => el.checked || el.getAttribute('aria-checked') === 'true'
        );
      } catch (_) {
        // ignore
      }
      logger.info(`Schedule radio checked after click attempt: ${radioChecked}`);

      if (scheduleClicked) {
        await page.waitForSelector('.scheduled-picker', { state: 'visible', timeout: 5000 }).catch(() => {});
        // Give the UI a moment after selecting the Schedule option so it doesn't overwrite our values
        await sleep(2000);

        const inputs = page.locator('.scheduled-picker input.TUXTextInputCore-input');
        const { timeInput, dateInput } = await identifyScheduleInputs(inputs, logger);

        if (timeInput && dateInput) {
          await setSchedulePickers(page, { timeInput, dateInput }, timeStr, isoDate, logger);
          logger.info(`Scheduled post (request): ${isoDate} ${timeStr} (from sheet: ${scheduledAtRaw})`);
          await sleep(800);
        } else {
          logger.warn('Schedule inputs not found or incomplete after opening scheduler.');
        }
      } else {
        logger.warn('Schedule radio not found/clickable; leaving as Now.');
      }
    } else {
      logger.warn(`Cannot parse scheduled_at value: ${scheduledAtRaw}; leaving as Now.`);
    }
  } else {
    await clickScheduleButtonOnly(page, logger);
  }

  // Check for copyright and content violations
  const violationResult = await checkForViolations(page, logger);
  
  if (!violationResult.ok) {
    logger.error(`❌ Video ${video.ID} has violations or check failed. Skipping post.`);
    return {
      success: false,
      note: violationResult.note || "Violation detected or check failed"
    };
  }

  await sleep(2000);

  const postButtons = page.locator(selectors.postButton);
  const textPattern = video && video.scheduled_at
    ? /Lên lịch|Schedule|Đăng bài|Đăng/i
    : /Đăng bài|Đăng|Post|Publish/i;
  const postButtonByText = postButtons.filter({ hasText: textPattern }).first();
  const matchingCount = await postButtonByText.count();
  logger.info(`Found ${matchingCount} localized post button(s) for text pattern ${textPattern}`);

  const postButton = matchingCount > 0 ? postButtonByText : postButtons.first();
  if (matchingCount === 0) {
    logger.warn(
      "Localized post button text not found; falling back to the first post_video_button element."
    );
  }

  await postButton.waitFor({ state: "visible", timeout: 20000 });

  const startUrl = page.url();
  const navigationPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
  await postButton.click();
  logger.info(`Clicked post button for ${video.ID}`);

  await navigationPromise;
  const finalUrl = page.url();
  const redirectedToStudio = finalUrl.includes("/tiktokstudio/content") || finalUrl.includes("/tiktokstudio");

  if (redirectedToStudio) {
    logger.info(`Detected redirect to TikTok Studio content page after posting: ${finalUrl}`);
    // Wait a short moment so any final UI activity completes, then return.
    try {
      logger.info('Waiting 3s after redirect before continuing');
      await sleep(3000);
    } catch (err) {
      logger.warn('Sleep interrupted', { error: err.message });
    }

    // Do NOT close the page or context here — return success so the caller's
    // loop can continue to the next video while keeping the browser open.
    return {
      success: true,
      note: violationResult.note || `Completed by redirect to ${finalUrl}`
    };
  }

  await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});

  return {
    success: true,
    note: violationResult.note || "Uploaded successfully"
  };
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

function buildCaptionWithProfileHashtags(caption, user) {
  const baseCaption = String(caption || "").trim();
  // Previously we pulled hashtags from the profile config here.
  // New behavior: do not auto-append config hashtags. Hashtags will be
  // inserted by clicking items from the caption history UI after typing.
  return baseCaption;
}

async function clickHashtagHistory(page, logger, maxToClick = 8) {
  try {
    // Wait briefly for history container to render
    await sleep(500);
    const historyItems = page.locator('.caption-history .suggest-item');
    const initialCount = Math.min(await historyItems.count(), 10);
    logger.info(`Found ${initialCount} hashtag history items (capped at 10)`);

    let clicked = 0;
    // Click the first element repeatedly, since TikTok removes a tag from history when selected
    for (let i = 0; i < initialCount && clicked < maxToClick; i++) {
      const first = page.locator('.caption-history .suggest-item').first();
      const exists = await first.count();
      if (!exists) break;
      const text = (await first.textContent()) || '';
      const tag = text.trim();
      if (!tag || !tag.startsWith('#')) {
        // If the first item isn't a hashtag, skip it and try next
        await first.click({ force: true }).catch(() => {});
        await sleep(200);
        continue;
      }

      logger.info(`Clicking (first) hashtag history item: ${tag} (iteration ${i + 1})`);
      try {
        await first.click({ force: true });
        clicked++;
        await sleep(300);
      } catch (err) {
        logger.warn('Failed to click history hashtag', { tag, error: err.message });
      }
    }

    logger.info(`Clicked ${clicked} hashtag(s) from history`);
    return clicked;
  } catch (err) {
    logger.warn('clickHashtagHistory failed', { error: err.message });
    return 0;
  }
}

async function editSound(page, logger) {
  logger.info("Opening sound tab...");

  const soundTab = page.locator(soundSelectors.soundTabButton).first();
  await soundTab.click();

  await page.waitForSelector("div.MusicPanelContainer__root", {
    timeout: 20000
  });
  logger.info("Sound panel opened.");

  // await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await sleep(2000);

  // sleep để thêm nhạc yêu thích thủ công
  // await sleep(360000);

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
      await saveButton.click();
      logger.info("Clicked Save/Lưu button.");
      await saveButton.waitFor({ state: "detached", timeout: 2000 }).catch(() => {});
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

async function clickScheduleButtonOnly(page, logger) {
  logger.info("Opening schedule panel for now-post flow...");

  const scheduleButtons = page.locator(
    "button:has-text('Lên lịch'), button:has-text('Đặt lịch'), button:has-text('Schedule'), button:has-text('Set schedule')"
  );
  const count = await scheduleButtons.count();

  if (count === 0) {
    logger.warn("No schedule button found for now-post flow.");
    return;
  }

  const targetButton = count > 1 ? scheduleButtons.nth(1) : scheduleButtons.first();
  await targetButton.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await targetButton.click().catch(() => targetButton.evaluate((el) => el.click()));
  logger.info(`Clicked schedule button for now-post flow (index ${count > 1 ? 2 : 1}).`);
  await sleep(500);
}

function formatDateForInput(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${year}-${month}-${day}`;
}

function selectInputRole(inputMeta) {
  const lower = inputMeta.toLowerCase();
  if (/date|ngày|ngay/.test(lower)) return "date";
  if (/time|giờ|gio|hh|mm/.test(lower)) return "time";
  return null;
}

async function identifyScheduleInputs(inputs, logger) {
  let timeInput = null;
  let dateInput = null;
  const candidates = [];
  const count = await inputs.count();

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const [value, placeholder, ariaLabel, name, type] = await Promise.all([
      input.getAttribute("value").catch(() => ""),
      input.getAttribute("placeholder").catch(() => ""),
      input.getAttribute("aria-label").catch(() => ""),
      input.getAttribute("name").catch(() => ""),
      input.getAttribute("type").catch(() => "")
    ]);

    const meta = `${value} ${placeholder} ${ariaLabel} ${name} ${type}`.trim();
    const role = selectInputRole(meta);
    const isTime = /^\d{1,2}:\d{2}$/.test(value) || role === "time";
    const isDate = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})$/.test(value) || role === "date";

    if (isTime) {
      timeInput = input;
    }
    if (isDate) {
      dateInput = input;
    }
    candidates.push({ input, isTime, isDate, meta, index: i });
  }

  if (!timeInput || !dateInput) {
    // Fallback to position if only two inputs are present
    if (count === 2) {
      const first = inputs.nth(0);
      const second = inputs.nth(1);
      if (!timeInput) timeInput = first;
      if (!dateInput) dateInput = second;
    }
  }

  if (!timeInput || !dateInput) {
    logger.warn("Could not reliably identify schedule date/time inputs.", { candidates });
  }

  return { timeInput, dateInput };
}

async function setSchedulePickers(page, { timeInput, dateInput }, timeStr, isoDate, logger) {
  const altDate = formatDateForInput(isoDate);

  if (dateInput) {
    await setDatePicker(page, dateInput, isoDate, logger);
  }
  if (timeInput) {
    await setTimePicker(page, timeInput, timeStr, logger);
  }

  await page.evaluate(() => {
    const active = document.activeElement;
    if (active) active.blur();
  });
  await sleep(1000);

  const finalTime = timeInput ? await timeInput.getAttribute('value').catch(() => null) : null;
  let finalDate = dateInput ? await dateInput.getAttribute('value').catch(() => null) : null;

  if (dateInput && finalDate !== isoDate && finalDate !== altDate) {
    logger.info('Date input after picker did not persist, falling back to direct value', { finalDate, isoDate, altDate });
    await setInputValue(dateInput, altDate);
    await sleep(1000);
    finalDate = await dateInput.getAttribute('value').catch(() => null);
    
    // If value is still not correct, try one more time
    if (finalDate !== isoDate && finalDate !== altDate) {
      logger.info('Date value still incorrect after setInputValue, retrying...', { finalDate, isoDate, altDate });
      await setInputValue(dateInput, altDate);
      await sleep(1000);
      finalDate = await dateInput.getAttribute('value').catch(() => null);
    }
  }

  logger.info(`Scheduled values after picker: date=${finalDate}, time=${finalTime}`);
}

async function setTimePicker(page, timeInput, timeStr, logger) {
  const [hour, minute] = timeStr.split(":");
  await timeInput.click({ force: true }).catch(() => {});
  await sleep(2000);

  const timePickerVisible = await page.locator('.tiktok-timepicker-time-picker-container:not(.tiktok-timepicker-invisible)').first();
  if (!(await timePickerVisible.count())) {
    await page.waitForSelector('.tiktok-timepicker-time-picker-container', { timeout: 3000 }).catch(() => {});
  }

  const hourLocator = page.locator('.tiktok-timepicker-option-text.tiktok-timepicker-left', { hasText: hour });
  if (await hourLocator.count()) {
    await hourLocator.first().click().catch(() => {});
  }

  const minuteLocator = page.locator('.tiktok-timepicker-option-text.tiktok-timepicker-right', { hasText: minute });
  if (await minuteLocator.count()) {
    await minuteLocator.first().click().catch(() => {});
  }

  await page.click('body', { force: true }).catch(() => {});
  await sleep(200);
  logger.info(`Time picker set to ${timeStr}`);
}

async function setDatePicker(page, dateInput, isoDate, logger) {
  const [year, month, day] = isoDate.split("-");
  const dateStr = `${year}-${month}-${day}`;
  
  logger.info(`Opening date picker to select day ${day}`);
  
  // Click to open picker
  await dateInput.click({ force: true }).catch(() => {});
  await sleep(1500);
  
  // Try to find and click the day in the picker
  // Look for span with class "day" containing the day number
  const dayElements = page.locator('span.day');
  const dayCount = await dayElements.count();
  logger.info(`Found ${dayCount} day elements in picker`);
  
  // Find the day with text matching our target day
  let dayClicked = false;
  for (let i = 0; i < dayCount; i++) {
    const dayText = await dayElements.nth(i).textContent().catch(() => null);
    if (dayText && dayText.trim() === day) {
      logger.info(`Found matching day ${day} at index ${i}, clicking...`);
      await dayElements.nth(i).click().catch(() => {});
      dayClicked = true;
      await sleep(500);
      break;
    }
  }
  
  if (!dayClicked) {
    logger.warn(`Could not find day ${day} in picker, will try direct value set`);
    // Fallback: click outside to close picker and set value directly
    await page.click('body').catch(() => {});
    await sleep(300);
    await setInputValue(dateInput, dateStr);
  }
  
  await sleep(500);
  const finalValue = await dateInput.getAttribute('value').catch(() => null);
  logger.info(`Date after picker selection: ${finalValue}`);
}

async function setInputValue(input, value) {
  await input.evaluate((el, v) => {
    el.removeAttribute('readonly');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }, value);
}

async function checkForViolations(page, logger) {
  logger.info("Checking for copyright and content violations...");
  
  try {
    // After saving music selection, the page may refresh or show a background check state.
    try {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 });
    } catch (_) {
      // navigation may not happen; continue polling the current page state
    }

    const CHECK_TIMEOUT_MS = 40000;
    const POLL_INTERVAL_MS = 1000;
    const start = Date.now();

    const checkingPhrases = [
      "đang kiểm tra",
      "checking",
      "đang kiểm tra.",
      "checking for",
      "checking...",
      "đang kiểm tra..."
    ];
    const okPhrases = [
      "không phát hiện vấn đề nào",
      "no issues found",
      "no issues detected"
    ];
    const checkLimitPhrases = [
      "bạn đã đạt giới hạn kiểm tra hôm nay",
      "you have reached today's check limit",
      "you have reached the limit for checks today",
      "limit reached",
      "check limit"
    ];
    const failPhrases = [
      "hạn chế",
      "restricted",
      "lỗi",
      "error",
      "vi phạm",
      "violation"
    ];

    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForSelector(".status-result, .status-tip", { timeout: 15000 }).catch(() => {});

    let visibleStatusSummary = "";
    let bodyText = "";
    let normalized = "";
    let note = "";

    while (Date.now() - start < CHECK_TIMEOUT_MS) {
      bodyText = await page.evaluate(() => document.body.innerText || "");
      normalized = (bodyText || "").toLowerCase();

      if (checkingPhrases.some((phrase) => normalized.includes(phrase))) {
        logger.info("Background checks still in progress; waiting for completion...");
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const statusResult = await page.evaluate(() => {
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            el.offsetWidth > 0 &&
            el.offsetHeight > 0
          );
        };

        const gatherTexts = (selector) =>
          Array.from(document.querySelectorAll(selector))
            .filter(isVisible)
            .map((el) => el.innerText.trim())
            .filter(Boolean);

        return {
          success: gatherTexts(".status-result.status-success .status-tip"),
          warn: gatherTexts(".status-result.status-warn .status-tip"),
          error: gatherTexts(".status-result.status-error .status-tip"),
          all: gatherTexts(".status-result .status-tip")
        };
      });

      const successCount = statusResult.success.length;
      const warnCount = statusResult.warn.length;
      const errorCount = statusResult.error.length;
      const visibleStatusTexts = statusResult.all;
      visibleStatusSummary = visibleStatusTexts.join(" | ").trim();

      note = visibleStatusSummary || bodyText.trim();

      if (successCount >= 2) {
        logger.info(`Decision: pass because visible status panel shows >=2 success rows. Criteria: successCount=${successCount}, warnCount=${warnCount}, errorCount=${errorCount}.`);
        logger.info(`Visible status texts: ${visibleStatusSummary}`);
        logger.info("✓ Both copyright and content checks passed - no issues found (DOM visible)");
        return { ok: true, note };
      }

      if (warnCount > 0 || errorCount > 0) {
        logger.error(`Decision: fail because visible status panel shows warning/error rows. Criteria: successCount=${successCount}, warnCount=${warnCount}, errorCount=${errorCount}.`);
        logger.error(`Visible status texts: ${visibleStatusSummary}`);
        logger.error("✗ Detected restriction/warning/error in visible status elements");
        return { ok: false, note: note || "Detected warning/error in visible status elements" };
      }

      let okCount = 0;
      const matchedOkPhrases = [];
      for (const phrase of okPhrases) {
        const matches = bodyText.match(new RegExp(phrase, "gi")) || [];
        okCount += matches.length;
        if (matches.length > 0) {
          matchedOkPhrases.push(`${phrase}:${matches.length}`);
        }
      }
      if (okCount >= 2) {
        logger.info(`Decision: pass because page text contains >=2 OK phrases. Criteria: okCount=${okCount}.`);
        logger.info(`Matched OK phrases: ${matchedOkPhrases.join(", ")}`);
        logger.info("✓ Both copyright and content checks passed - no issues found (text)");
        return { ok: true, note };
      }

      const matchedFailPhrases = failPhrases.filter((phrase) => normalized.includes(phrase));
      const matchedLimitPhrases = checkLimitPhrases.filter((phrase) => normalized.includes(phrase));
      if (matchedLimitPhrases.length > 0) {
        logger.error(`Decision: fail because check limit reached: ${matchedLimitPhrases.join(", ")}`);
        logger.error(`Visible status texts: ${visibleStatusSummary}`);
        return { ok: false, note: "Bạn đã đạt giới hạn kiểm tra hôm nay. Hãy thử lại vào ngày mai." };
      }
      if (matchedFailPhrases.length > 0) {
        logger.error(`Decision: fail because page text contains fail phrases: ${matchedFailPhrases.join(", ")}`);
        logger.error(`Visible status texts: ${visibleStatusSummary}`);
        logger.error("✗ Detected restriction or violation in page text (fallback)");
        return { ok: false, note: note || `Detected fail phrases: ${matchedFailPhrases.join(", ")}` };
      }

      logger.info("No final status yet; polling again...");
      await sleep(POLL_INTERVAL_MS);
    }

    logger.error("Decision: fail because timeout waiting for content/music checks to complete.");
    logger.error(`Visible status texts: ${visibleStatusSummary}`);
    return { ok: false, note: `timeout because timeout waiting for content/music checks to: ${note || visibleStatusSummary}` };
  } catch (error) {
    logger.error("Error during violation check", { error: error.message });
    return { ok: false, note: `Error during violation check: ${error.message}` };
  }
}

