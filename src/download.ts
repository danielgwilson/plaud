import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getRecordingTempUrls, getRecordingDetailsBatch } from "./plaud-api.js";
import { formatTranscript, getFilenameWithDate, sanitizeFilename } from "./recordings-format.js";

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function streamToFile({
  url,
  outPath,
  timeoutMs = 60_000,
}: {
  url: string;
  outPath: string;
  timeoutMs?: number;
}): Promise<{ bytes: number | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error("Download failed: empty body");
    await ensureDir(path.dirname(outPath));

    const fileStream = createWriteStream(outPath);
    await new Promise<void>((resolve, reject) => {
      fileStream.on("error", reject);
      fileStream.on("close", resolve);
      Readable.fromWeb(res.body as any).pipe(fileStream);
    });
    return { bytes: Number(res.headers.get("content-length") || 0) || null };
  } finally {
    clearTimeout(timeout);
  }
}

async function getDetails({ token, id, region = "us" }: { token: string; id: string; region?: "us" | "eu" }): Promise<any> {
  const list = await getRecordingDetailsBatch({ token, ids: [id], region });
  const details = Array.isArray(list) ? list.find((d) => String(d?.id || "") === String(id)) : null;
  if (!details) throw new Error("Recording not found (or details unavailable)");
  return details;
}

function parseWhat(what: string): Set<string> {
  const parts = String(what || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(parts.length ? parts : ["transcript", "summary", "json"]);
}

export async function downloadRecording({
  token,
  id,
  outDir,
  what = "transcript,summary,json",
  audioFormat = "opus",
  region = "us",
}: {
  token: string;
  id: string;
  outDir: string;
  what?: string;
  audioFormat?: string;
  region?: "us" | "eu";
}): Promise<{ id: string; outDir: string; written: Array<Record<string, unknown>> }> {
  if (!token) throw new Error("Missing token");
  if (!id) throw new Error("Missing id");
  if (!outDir) throw new Error("Missing outDir");

  const whatSet = parseWhat(what);
  const details = await getDetails({ token, id, region });
  const baseFilename = getFilenameWithDate(details?.filename, { id }, details);
  const written: Array<Record<string, unknown>> = [];

  await ensureDir(outDir);

  if (whatSet.has("json")) {
    const jsonPath = path.join(outDir, `${baseFilename}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(details, null, 2), "utf8");
    written.push({ kind: "json", path: jsonPath });
  }

  if (whatSet.has("transcript")) {
    const transcript = formatTranscript(details?.trans_result);
    const transcriptPath = path.join(outDir, `${baseFilename}.txt`);
    await fs.writeFile(transcriptPath, transcript, "utf8");
    written.push({ kind: "transcript", path: transcriptPath });
  }

  if (whatSet.has("summary")) {
    const ai = details?.ai_content ? String(details.ai_content) : "";
    const mdPath = path.join(outDir, `${baseFilename}_ai.md`);
    await fs.writeFile(mdPath, ai, "utf8");
    written.push({ kind: "summary", path: mdPath });
  }

  if (whatSet.has("audio")) {
    const temp = await getRecordingTempUrls({ token, id, region });
    const tempUrl = audioFormat === "original" ? temp?.temp_url : temp?.temp_url_opus || temp?.temp_url;
    if (!tempUrl) throw new Error("Audio temp URL not available for this recording");

    const ext = audioFormat === "opus" ? "opus" : "m4a";
    const audioName = sanitizeFilename(`${baseFilename}.${ext}`);
    const audioPath = path.join(outDir, audioName);
    const info = await streamToFile({ url: tempUrl, outPath: audioPath });
    written.push({ kind: "audio", path: audioPath, bytes: info.bytes });
  }

  return { id: String(id), outDir, written };
}

