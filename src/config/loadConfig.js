import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

export function loadConfig() {
  const rootDir = process.cwd();
  const usersConfigPath = resolveFromRoot(
    rootDir,
    process.env.USERS_CONFIG_PATH || "./config/users.json"
  );

  const commonProfilesDir = resolveFromRoot(
    rootDir,
    process.env.CHROME_PROFILES_DIR || "../chrome-profiles"
  );

  return {
    rootDir,
    googleSheetId: requireEnv("GOOGLE_SHEET_ID"),
    googleCredentialsPath: resolveFromRoot(
      rootDir,
      requireEnv("GOOGLE_APPLICATION_CREDENTIALS")
    ),
    videoRoot: resolveFromRoot(rootDir, process.env.VIDEO_ROOT || "../videos"),
    usersConfigPath,
    uploadLimitPerRun: Number(process.env.UPLOAD_LIMIT_PER_RUN || 3),
    headless: process.env.HEADLESS === "true",
    dryRun: process.env.DRY_RUN !== "false",
    tiktokUploadUrl:
      process.env.TIKTOK_UPLOAD_URL || "https://www.tiktok.com/tiktokstudio/upload",
    users: loadUsers(rootDir, usersConfigPath, commonProfilesDir),
    commonProfilesDir
  };
}

function loadUsers(rootDir, usersConfigPath, commonProfilesDir) {
  if (!fs.existsSync(usersConfigPath)) {
    throw new Error(
      `Missing users config: ${usersConfigPath}. Copy config/users.example.json to config/users.json first.`
    );
  }

  const users = JSON.parse(fs.readFileSync(usersConfigPath, "utf8"));
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error("config/users.json must contain at least one user.");
  }

  return users.map((user) => ({
    ...user,
    chromeUserDataDir: user.chromeUserDataDir
      ? resolveFromRoot(rootDir, user.chromeUserDataDir)
      : path.resolve(commonProfilesDir, user.name)
  }));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function resolveFromRoot(rootDir, maybeRelativePath) {
  if (path.isAbsolute(maybeRelativePath)) {
    return maybeRelativePath;
  }
  return path.resolve(rootDir, maybeRelativePath);
}
