import fs from "node:fs";
import path from "node:path";

export function resolveVideoPath(videoRoot, videoPath) {
  if (path.isAbsolute(videoPath)) {
    return videoPath;
  }
  return path.resolve(videoRoot, videoPath);
}

export function assertFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file not found: ${filePath}`);
  }
}
