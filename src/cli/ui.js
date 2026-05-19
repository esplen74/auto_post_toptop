#!/usr/bin/env node

import http from "node:http";
import { exec } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { createLogger } from "../logging/logger.js";
import { downloadPendingVideos } from "./downloadDouyin.js";
import { uploadPendingVideos } from "./index.js";

const PORT = 3000;
const DOWNLOAD_PROFILE_PATH = "/Users/lphee98/Auto_TopTop/chrome-profiles/auto-download";
const API_TIMEOUT_MS = 1000 * 60 * 60; // 1 hour

const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Auto TikTok Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b1020;
      color: #f5f7ff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .panel { width: min(520px, 100%); background: radial-gradient(circle at top, rgba(82, 98, 255, 0.16), transparent 36%), #111523; border: 1px solid rgba(255,255,255,0.08); border-radius: 28px; padding: 32px; box-shadow: 0 28px 80px rgba(0, 0, 0, 0.35); }
    .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }
    .brand-icon { width: 46px; height: 46px; display: grid; place-items: center; background: linear-gradient(135deg, #7f5fff, #1a8cff); border-radius: 16px; }
    .brand-icon svg { width: 28px; height: 28px; }
    .brand-text { line-height: 1.1; }
    .brand-text h1 { margin: 0; font-size: 1.4rem; letter-spacing: -0.03em; }
    .brand-text p { margin: 4px 0 0; color: #9cb0ff; font-size: 0.95rem; }
    .buttons { display: grid; gap: 14px; margin-bottom: 22px; }
    button { border: none; border-radius: 16px; padding: 16px 18px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease; }
    button:hover:not(:disabled) { transform: translateY(-1px); }
    button.primary { background: linear-gradient(135deg, #6c6cff, #1c7fff); color: #fff; box-shadow: 0 18px 40px rgba(28, 127, 255, 0.2); }
    button.secondary { background: linear-gradient(135deg, #2c7a4f, #1ec06b); color: #fff; box-shadow: 0 18px 40px rgba(30, 192, 107, 0.2); }
    button:disabled { opacity: 0.55; cursor: not-allowed; transform: none; box-shadow: none; }
    .meta { display: grid; gap: 8px; margin-bottom: 20px; font-size: 0.94rem; color: #abb4d0; }
    .meta span { display: block; }
    .status { min-height: 140px; background: rgba(16, 24, 48, 0.95); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 18px; color: #e6e9ff; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: pre-wrap; overflow-y: auto; line-height: 1.55; }
    .status::before { content: 'Trạng thái'; display: block; margin-bottom: 12px; color: #8c9ed8; font-size: 0.92rem; }
  </style>
</head>
<body>
  <div class="panel">
    <div class="brand">
      <div class="brand-icon">
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="32" cy="32" r="30" fill="white" fill-opacity="0.08" />
          <path d="M24 20C24 20 28 16 34 16C40 16 44 20 44 26C44 32 40 36 34 36C30 36 28 34 28 30C28 26 32 24 36 26" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M27 32V44" stroke="white" stroke-width="3" stroke-linecap="round" />
          <path d="M37 28V44" stroke="white" stroke-width="3" stroke-linecap="round" />
        </svg>
      </div>
      <div class="brand-text">
        <h1>Auto TikTok Dashboard</h1>
        <p>Nhấn nút khi bạn muốn bắt đầu download Douyin hoặc upload TikTok.</p>
      </div>
    </div>

    <div class="buttons">
      <button id="downloadBtn" class="primary">Tải Douyin Video</button>
      <button id="uploadBtn" class="secondary">Upload TikTok</button>
    </div>

    <div class="status" id="status">Sẵn sàng. Nhấn một nút để bắt đầu.</div>
  </div>

  <script>
    const status = document.getElementById('status');
    const downloadBtn = document.getElementById('downloadBtn');
    const uploadBtn = document.getElementById('uploadBtn');

    function appendMessage(text) {
      status.textContent += '\\n' + text;
      status.scrollTop = status.scrollHeight;
    }

    async function runAction(path) {
      downloadBtn.disabled = true;
      uploadBtn.disabled = true;
      const actionLabel = path === '/download' ? 'Tải Douyin video' : 'Upload TikTok';
      status.textContent = 'Đang thực hiện: ' + actionLabel + '...';

      try {
        const response = await fetch(path, { method: 'POST' });
        const result = await response.text();
        appendMessage('---');
        appendMessage(result.trim() || 'Hoàn tất.');
        if (!response.ok) {
          appendMessage('Trạng thái: ' + response.status + ' ' + response.statusText);
        }
      } catch (error) {
        appendMessage('Lỗi: ' + error.message);
      } finally {
        downloadBtn.disabled = false;
        uploadBtn.disabled = false;
      }
    }

    downloadBtn.addEventListener('click', () => runAction('/download'));
    uploadBtn.addEventListener('click', () => runAction('/upload'));
  </script>
</body>
</html>`;

const config = loadConfig();
const logger = createLogger(config.rootDir);
let currentTask = null;

async function startServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      logger.info(`HTTP GET ${req.url}`);
      res.writeHead(200, { "Content-Type": "text/html; charset=UTF-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && (req.url === "/download" || req.url === "/upload")) {
      if (currentTask) {
        logger.warn(`Đã có tác vụ đang chạy: ${currentTask}. Từ chối ${req.url}`);
        res.writeHead(409, { "Content-Type": "text/plain; charset=UTF-8" });
        res.end("Một tác vụ đang chạy. Vui lòng chờ cho đến khi hoàn tất.");
        return;
      }

      const action = req.url.slice(1);
      currentTask = action;
      logger.info(`Bắt đầu tác vụ ${action}`);
      res.writeHead(200, { "Content-Type": "text/plain; charset=UTF-8" });
      res.write(`Bắt đầu ${action}...\n`);

      try {
        if (action === "download") {
          await downloadPendingVideos({
            config,
            logger,
            requestedProfile: DOWNLOAD_PROFILE_PATH,
            maxRows: 0
          });
          logger.info("Download Douyin hoàn tất.");
          res.write("Hoàn thành download.\n");
        } else {
          await uploadPendingVideos({ config, logger });
          logger.info("Upload TikTok hoàn tất.");
          res.write("Hoàn thành upload.\n");
        }
      } catch (error) {
        logger.error(`Tác vụ ${action} lỗi: ${error.message}`, { stack: error.stack });
        res.write(`Lỗi: ${error.message}\n`);
      } finally {
        currentTask = null;
        logger.info(`Tác vụ ${action} đã kết thúc.`);
        res.end();
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=UTF-8" });
    res.end("Not Found");
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    logger.info(`UI server started at ${url}`);
    if (process.platform === "darwin") {
      exec(`open "${url}"`);
    }
    console.log(`Mở trình duyệt tại: ${url}`);
  });
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
