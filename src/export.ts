import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import yazl from "yazl";
import { listRecordings, getRecordingDetailsBatch } from "./plaud-api.js";
import { formatTranscript, getFilenameWithDate } from "./recordings-format.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export type ExportFormats = { txt: boolean; json: boolean; md: boolean };

export type ExportProgress = { current: number; total: number };

export type ExportSummary = {
  exportDate: string;
  totalFiles: number;
  successful: number;
  failed: Array<{ success: false; id: string; filename?: string; error?: string }>;
  includesTrash: boolean;
  since: string | null;
  until: string | null;
  outDir: string | null;
  zipPath: string | null;
};

export async function exportRecordings({
  token,
  outDir,
  zipPath,
  includeTrash = false,
  formats = { txt: true, json: true, md: true },
  batchSize = 10,
  delayMs = 300,
  max = Infinity,
  since,
  until,
  resume = false,
  region = "us",
  onProgress,
}: {
  token: string;
  outDir: string;
  zipPath: string | null;
  includeTrash?: boolean;
  formats?: ExportFormats;
  batchSize?: number;
  delayMs?: number;
  max?: number;
  since?: string | null;
  until?: string | null;
  resume?: boolean;
  region?: "us" | "eu";
  onProgress?: (p: ExportProgress) => void;
}): Promise<ExportSummary> {
  const sinceDate = parseIsoDate(since || null);
  const untilDate = parseIsoDate(until || null);

  const recordings = await listRecordings({ token, includeTrash, max, region });
  const filtered = recordings.filter((r) => {
    const ts = r?.start_time || r?.edit_time;
    if (!ts) return true;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return true;
    if (sinceDate && d < sinceDate) return false;
    if (untilDate && d > untilDate) return false;
    return true;
  });

  const progress = { current: 0, total: filtered.length };
  const results: Array<{ success: true; id: string; filename?: string } | { success: false; id: string; filename?: string; error?: string }> = [];

  let zip: yazl.ZipFile | null = null;
  let zipStream: ReturnType<typeof createWriteStream> | null = null;
  if (zipPath) {
    await ensureDir(path.dirname(zipPath));
    zipStream = createWriteStream(zipPath);
    zip = new yazl.ZipFile();
    zip.outputStream.pipe(zipStream);
  } else {
    await ensureDir(outDir);
    await ensureDir(path.join(outDir, "transcripts"));
    await ensureDir(path.join(outDir, "json"));
    await ensureDir(path.join(outDir, "ai-summaries"));
  }

  for (let i = 0; i < filtered.length; i += batchSize) {
    const batch = filtered.slice(i, i + batchSize);
    const ids = batch.map((f) => f.id).filter(Boolean) as string[];
    let detailsList: any[] = [];
    try {
      detailsList = await getRecordingDetailsBatch({ token, ids, region });
    } catch {
      // If the batch call fails, fall back to single-id requests for this batch.
      detailsList = [];
      for (const id of ids) {
        try {
          const single = await getRecordingDetailsBatch({ token, ids: [id], region });
          detailsList.push(...single);
        } catch {
          // leave missing
        }
      }
    }

    const detailsById = new Map(detailsList.map((d) => [d.id, d]));

    for (const file of batch) {
      const details = detailsById.get(file.id) || null;
      const filename = getFilenameWithDate(file.filename, file, details);

      try {
        const transcriptText = formats.txt ? formatTranscript(details?.trans_result) : null;
        const jsonText = formats.json ? JSON.stringify(details ?? {}, null, 2) : null;
        const aiText = formats.md ? (details?.ai_content ? String(details.ai_content) : "") : null;

        const jsonRel = `json/${filename}.json`;
        const txtRel = `transcripts/${filename}.txt`;
        const mdRel = `ai-summaries/${filename}_ai.md`;

        if (zip) {
          if (formats.json) zip.addBuffer(Buffer.from(jsonText || "{}", "utf8"), jsonRel);
          if (formats.txt && transcriptText) zip.addBuffer(Buffer.from(transcriptText, "utf8"), txtRel);
          if (formats.md && aiText) zip.addBuffer(Buffer.from(aiText, "utf8"), mdRel);
        } else {
          const jsonPath = path.join(outDir, jsonRel);
          const txtPath = path.join(outDir, txtRel);
          const mdPath = path.join(outDir, mdRel);

          if (formats.json) {
            if (!resume || !(await exists(jsonPath))) await fs.writeFile(jsonPath, jsonText || "{}", "utf8");
          }
          if (formats.txt && transcriptText) {
            if (!resume || !(await exists(txtPath))) await fs.writeFile(txtPath, transcriptText, "utf8");
          }
          if (formats.md && aiText) {
            if (!resume || !(await exists(mdPath))) await fs.writeFile(mdPath, aiText, "utf8");
          }
        }

        results.push({ success: true, id: String(file.id), filename: file.filename });
      } catch (error: any) {
        results.push({ success: false, id: String(file.id), filename: file.filename, error: error?.message });
      }

      progress.current++;
      if (onProgress) onProgress({ ...progress });
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  const summary = {
    exportDate: new Date().toISOString(),
    totalFiles: filtered.length,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r): r is { success: false; id: string; filename?: string; error?: string } => !r.success),
    includesTrash: includeTrash,
    since: since || null,
    until: until || null,
  };

  if (zip) {
    zip.addBuffer(Buffer.from(JSON.stringify(summary, null, 2), "utf8"), "export_summary.json");
    zip.end();
    await new Promise<void>((resolve, reject) => {
      if (!zipStream) return reject(new Error("zip stream missing"));
      zipStream.on("close", resolve);
      zipStream.on("error", reject);
    });
  } else {
    await fs.writeFile(path.join(outDir, "export_summary.json"), JSON.stringify(summary, null, 2), "utf8");
  }

  return {
    ...summary,
    outDir: zipPath ? null : outDir,
    zipPath: zipPath || null,
  };
}
