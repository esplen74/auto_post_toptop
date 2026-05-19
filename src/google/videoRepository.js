const REQUIRED_HEADERS = [
  "ID",
  "user",
  "video_path",
  "caption",
  "status",
  "posted_at",
  "scheduled_at",
  "note"
];

export class VideoRepository {
  constructor({ sheets, spreadsheetId, sheetName, logger = console }) {
    this.sheets = sheets;
    this.spreadsheetId = spreadsheetId;
    this.sheetName = sheetName;
    this.logger = logger;
  }

  async listRows() {
    const range = `${quoteSheetName(this.sheetName)}!A1:Z1000`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range
    });

    const values = response.data.values || [];
    if (values.length === 0) {
      return [];
    }

    const headers = values[0];
    validateHeaders(headers);

    return values.slice(1).map((row, index) => {
      const rowNumber = index + 2;
      const record = Object.fromEntries(
        headers.map((header, columnIndex) => [header, row[columnIndex] || ""])
      );

      return {
        rowNumber,
        ...record
      };
    });
  }

  async findPendingForUser(userName, limit) {
    const rows = await this.listRows();
    const now = new Date();
    const total = rows.length;
    const withPath = rows.filter((row) => row.video_path && row.video_path.trim() !== "");
    const withPathCount = withPath.length;
    const notDone = withPath.filter((row) => shouldPostStatus(row.status));
    const notDoneCount = notDone.length;
    // Do not filter out future scheduled rows here; uploader will handle scheduling option.
    const candidates = notDone;
    const candidatesCount = candidates.length;
    this.logger.info(`findPendingForUser: total=${total}, withPath=${withPathCount}, notDone=${notDoneCount}, candidates=${candidatesCount}`);

    if (candidatesCount === 0) {
      // log examples of excluded rows with reasons to help debugging
      const excluded = rows.filter((r) => {
        if (!r.video_path || String(r.video_path).trim() === "") return true;
        if (!shouldPostStatus(r.status)) return true;
        return false;
      });  
    }

    return candidates.slice(0, limit);
  }

  async findPending(limit) {
    const rows = await this.listRows();
    const now = new Date();
    const total = rows.length;
    const withPath = rows.filter((row) => row.video_path && row.video_path.trim() !== "");
    const withPathCount = withPath.length;
    const notDone = withPath.filter((row) => shouldPostStatus(row.status));
    const notDoneCount = notDone.length;
    // Do not filter out future scheduled rows here; uploader will handle scheduling option.
    const candidates = notDone;
    const candidatesCount = candidates.length;
    this.logger.info(`findPending: total=${total}, withPath=${withPathCount}, notDone=${notDoneCount}, candidates=${candidatesCount}`);

    if (candidatesCount === 0) {
      const excluded = rows.filter((r) => {
        if (!r.video_path || String(r.video_path).trim() === "") return true;
        if (!shouldPostStatus(r.status)) return true;
        return false;
      });
    }

    return candidates.slice(0, limit);
  }

  async markUploading(rowNumber) {
    await this.updateCells(rowNumber, {
      status: "UPLOADING"
    });
  }

  async markPosted(rowNumber, note = "") {
    await this.updateCells(rowNumber, {
      status: "DONE",
      posted_at: formatLocalPostedAt(),
      note
    });
  }

  async markFailed(rowNumber, note = "") {
    const updates = {
      status: "ERROR"
    };
    if (note) {
      updates.note = note;
    }

    await this.updateCells(rowNumber, updates);
  }

  async updateCells(rowNumber, updates) {
      // Read actual header row from the sheet to determine column indices —
      // do not rely on the static REQUIRED_HEADERS order when updating cells.
      const headerRange = `${quoteSheetName(this.sheetName)}!A1:Z1`;
      const headerResp = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: headerRange
      });

      const headers = (headerResp.data.values && headerResp.data.values[0]) || [];

      const data = Object.entries(updates).map(([header, value]) => {
        let columnIndex = headers.indexOf(header);
        if (columnIndex === -1 && header === "note") {
          columnIndex = headers.indexOf("tiktok_url");
        }

        if (columnIndex === -1) {
          throw new Error(`Unknown sheet header: ${header}`);
        }

        return {
          range: `${quoteSheetName(this.sheetName)}!${toColumnName(columnIndex + 1)}${rowNumber}`,
          values: [[value]]
        };
      });

    if (data.length === 0) {
      return;
    }

    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data
      }
    });
  }
}

function formatLocalPostedAt() {
  const now = new Date();
  return now.toLocaleString("sv-SE", {
    hour12: false,
    timeZone: process.env.POSTED_AT_TIMEZONE || undefined
  });
}

function validateHeaders(headers) {
  const missing = REQUIRED_HEADERS.filter((header) => {
    if (header === "note") {
      return !headers.includes("note") && !headers.includes("tiktok_url");
    }
    return !headers.includes(header);
  });
  if (missing.length > 0) {
    throw new Error(`Google Sheet is missing columns: ${missing.join(", ")}`);
  }
}

function quoteSheetName(sheetName) {
  // Only quote if the sheet name contains special characters, spaces, or starts with a number
  const needsQuotes = /[\s!@#$%^&*()+=\-\[\]{};:'"<>?,./\\|`~]|^\d/.test(sheetName);
  if (needsQuotes) {
    return `'${String(sheetName).replaceAll("'", "''")}'`;
  }
  return sheetName;
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function normalizeUserKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function shouldPostStatus(status) {
  const normalized = normalizeStatus(status);
  return normalized !== "done" && normalized !== "error";
}

function isDue(scheduledAt, now) {
  if (!scheduledAt) {
    return true;
  }

  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) {
    return true;
  }

  return scheduledDate <= now;
}

function toColumnName(columnNumber) {
  let name = "";
  let n = columnNumber;

  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }

  return name;
}
