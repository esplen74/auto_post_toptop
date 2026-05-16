import fs from "node:fs";
import path from "node:path";

export function createLogger(rootDir) {
  const logDir = path.join(rootDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.log`);

  function write(level, message, meta = {}) {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...meta
    });

    fs.appendFileSync(logFile, `${line}\n`);
    console.log(`[${level}] ${message}`);
  }

  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
    logFile
  };
}
