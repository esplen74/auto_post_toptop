import { chromium } from "playwright";

export async function launchChromeProfile({ user, headless }) {
  if (!user.chromeUserDataDir) {
    throw new Error(`User ${user.name} is missing chromeUserDataDir.`);
  }

  return await launchPersistentChrome({
    userDataDir: user.chromeUserDataDir,
    profileDirectory: user.chromeProfileDirectory,
    headless
  });
}

async function launchPersistentChrome({ userDataDir, profileDirectory, headless }) {
  const args = ["--disable-dev-shm-usage"];
  if (profileDirectory) {
    args.push(`--profile-directory=${profileDirectory}`);
  }

  try {
    return await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless,
      viewport: { width: 1365, height: 900 },
      args,
      locale: "vi-VN",
      timeout: 60000,
      ignoreDefaultArgs: ["--no-sandbox"]
    });
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new Error(
        `Chrome launch timed out. Make sure Chrome is installed, close any running Chrome instances using the same profile/data directory, and use a dedicated automation profile path in config/users.json if needed. Original error: ${error.message}`
      );
    }

    if (
      error.message.includes("Target page, context or browser has been closed") ||
      error.message.includes("Mở trong phiên trình duyệt hiện tại")
    ) {
      throw new Error(
        `Chrome failed to attach to the requested profile. Close any running Chrome instance using this profile or use a separate automation-only chromeUserDataDir in config/users.json. Original error: ${error.message}`
      );
    }

    throw error;
  }
}
