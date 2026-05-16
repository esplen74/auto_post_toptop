import { chromium } from "playwright";

export async function launchChromeProfile({ user, headless }) {
  if (!user.chromeUserDataDir) {
    throw new Error(`User ${user.name} is missing chromeUserDataDir.`);
  }

  try {
    return await launchPersistentChrome({
      userDataDir: user.chromeUserDataDir,
      profileDirectory: user.chromeProfileDirectory,
      headless
    });
  } catch (error) {
    if (error.message.includes("Target page, context or browser has been closed")) {
      throw new Error(
        [
          `Cannot open Chrome profile for ${user.name}.`,
          `Chrome user data is still locked by a running Google Chrome process.`,
          `The tool will not fallback to another profile because that would use the wrong TikTok user.`,
          `Quit Google Chrome completely, then run again.`,
          `Profile: ${user.chromeProfileDirectory || "Default"}.`,
          `Path: ${user.chromeUserDataDir}.`
        ].join(" ")
      );
    }

    throw error;
  }
}

async function launchPersistentChrome({ userDataDir, profileDirectory, headless }) {
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage"
  ];
  if (profileDirectory) {
    args.push(`--profile-directory=${profileDirectory}`);
  }

  return chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless,
    viewport: { width: 1365, height: 900 },
    args,
    locale: "vi-VN"
  });
}
