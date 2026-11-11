import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mirrors the Plaud web app's "Import audio" flow (web.plaud.ai):
//   1. non-MP3 input is transcoded to MP3 in the browser (ffmpeg: mono, 16 kHz, libmp3lame V0)
//   2. POST /file/get_upload_presigned_url  { filesize, file_type: "MP3" }
//   3. PUT each 5 MB part to its presigned URL (no auth header), keep the ETag
//   4. POST /file/merge_multipart           { upload_id, object_name, parts }
//   5. POST /file/confirm_upload            { ...metadata }  -> the new file

export const PART_SIZE = 5 * 1024 * 1024;
export const PART_CONCURRENCY = 3;
export const PART_RETRIES = 3;
// Web app limits (limitSize defaults to 500 MB and is overridden by /others/web-config).
export const DEFAULT_LIMIT_MB = 500;
export const MIN_DURATION_SEC = 1;
export const MAX_DURATION_SEC = 5 * 3600;
// The web app's `scene` for files imported from the upload dialog.
export const IMPORT_SCENE = 101;

// Status codes the web app uses for a failed import, mapped to stable CLI error codes.
export const UPLOAD_STATUS = {
  DUPLICATE: -2,
  INVALID_FORMAT: -3,
  FILE_TOO_LARGE: -4,
  TOO_SHORT: -7,
  S3_UPLOAD_NETWORK_ERROR: -8,
} as const;

const STATUS_CODES: Record<number, { code: string; message: string }> = {
  [UPLOAD_STATUS.DUPLICATE]: { code: "DUPLICATE", message: "Plaud already has a file with this title." },
  [UPLOAD_STATUS.INVALID_FORMAT]: { code: "INVALID_FORMAT", message: "Plaud rejected the file as an invalid audio format." },
  [UPLOAD_STATUS.FILE_TOO_LARGE]: { code: "FILE_TOO_LARGE", message: "The file is larger than Plaud's upload limit." },
  [UPLOAD_STATUS.TOO_SHORT]: { code: "TOO_SHORT", message: "The recording is too short for Plaud to transcribe (under 1 second)." },
  [UPLOAD_STATUS.S3_UPLOAD_NETWORK_ERROR]: { code: "UPLOAD_NETWORK_ERROR", message: "The upload to Plaud storage failed on the network." },
};

export class UploadError extends Error {
  code: string;
  status?: number;
  data?: unknown;
  constructor(code: string, message: string, extra: { status?: number; data?: unknown } = {}) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.status = extra.status;
    this.data = extra.data;
  }
}

export function uploadErrorForStatus(status: number, detail?: string): UploadError {
  const known = STATUS_CODES[status];
  if (!known) return new UploadError("UPLOAD_FAILED", detail || `Plaud upload failed (status ${status}).`);
  return new UploadError(known.code, detail ? `${known.message} (${detail})` : known.message);
}

/** Pull the web-app status code out of an API error or an `{ status: <n> }` body, if it is one we know. */
export function knownStatusFrom(err: any): number | null {
  const candidates = [err?.data?.status, err?.status, err?.data?.code];
  for (const c of candidates) {
    if (typeof c === "number" && STATUS_CODES[c]) return c;
  }
  return null;
}

export type Part = { index: number; partNumber: number; start: number; end: number };

/** Byte ranges for each part. A file at or under one part size is a single part. */
export function splitParts(size: number, partSize = PART_SIZE): Part[] {
  if (!Number.isFinite(size) || size <= 0) throw new UploadError("INVALID_FORMAT", "The file is empty.");
  const count = Math.ceil(size / partSize);
  const parts: Part[] = [];
  for (let i = 0; i < count; i++) {
    parts.push({ index: i, partNumber: i + 1, start: i * partSize, end: Math.min(size, (i + 1) * partSize) });
  }
  return parts;
}

export function buildPresignBody(size: number): { filesize: number; file_type: string } {
  return { filesize: size, file_type: "MP3" };
}

export function buildMergeBody({
  uploadId,
  objectName,
  etags,
}: {
  uploadId: string;
  objectName: string;
  etags: string[];
}): { upload_id: string; object_name: string; parts: Array<{ Etag: string; PartNumber: number }> } {
  return {
    upload_id: uploadId,
    object_name: objectName,
    parts: etags.map((etag, i) => ({ Etag: cleanEtag(etag), PartNumber: i + 1 })),
  };
}

export function cleanEtag(etag: string): string {
  return String(etag || "").replace(/"/g, "");
}

export function buildConfirmBody({
  uploadId,
  objectName,
  title,
  startTimeMs,
  timezoneHours,
  serialNumber,
  tagId,
}: {
  uploadId: string;
  objectName: string;
  title: string;
  startTimeMs: number;
  timezoneHours: number;
  serialNumber: string;
  tagId?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    upload_id: uploadId,
    object_name: objectName,
    scene: IMPORT_SCENE,
    is_tmp: 0,
    support_mul_summ: true,
    file_type: "MP3",
    filename: title,
    start_time: startTimeMs,
    session_id: Math.floor(startTimeMs / 1000),
    serial_number: serialNumber,
    timezone: timezoneHours,
  };
  if (tagId) body.filetag_id_list = [tagId];
  return body;
}

/** Hours east of UTC, as the web app sends it (`-getTimezoneOffset() / 60`). */
export function localTimezoneHours(now = new Date()): number {
  return -now.getTimezoneOffset() / 60 || 0;
}

export function defaultTitle(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function validateDuration(durationSec: number | null): void {
  if (durationSec === null) return;
  if (durationSec < MIN_DURATION_SEC) throw uploadErrorForStatus(UPLOAD_STATUS.TOO_SHORT);
  if (Math.floor(durationSec) > MAX_DURATION_SEC) {
    throw new UploadError("TOO_LONG", "The recording is longer than Plaud's 5 hour import limit. Split it first.");
  }
}

export function validateSize(sizeBytes: number, limitMb: number): void {
  if (sizeBytes > limitMb * 1024 * 1024) {
    throw new UploadError("FILE_TOO_LARGE", `The file is ${(sizeBytes / 1024 / 1024).toFixed(0)} MB; Plaud's import limit is ${limitMb} MB.`);
  }
}

// ---- Local media tools (ffmpeg / ffprobe) ----

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function probeDurationSec(filePath: string): Promise<number | null> {
  try {
    const r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
    if (r.code !== 0) return null;
    const n = Number.parseFloat(r.stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Same ffmpeg arguments the web app runs in the browser. */
export function ffmpegArgs(input: string, output: string): string[] {
  return ["-nostdin", "-y", "-i", input, "-vn", "-c:a", "libmp3lame", "-ar", "16000", "-ac", "1", "-qscale:a", "0", "-ignore_unknown", output];
}

export async function transcodeToMp3(input: string, output: string): Promise<void> {
  let r;
  try {
    r = await run("ffmpeg", ffmpegArgs(input, output));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new UploadError(
        "FFMPEG_MISSING",
        "Plaud only accepts MP3 uploads; the web app converts other formats in the browser. Install ffmpeg (brew install ffmpeg) or convert the file to MP3 first.",
      );
    }
    throw err;
  }
  if (r.code !== 0) {
    const tail = r.stderr.trim().split("\n").slice(-3).join(" | ");
    throw new UploadError("INVALID_FORMAT", `ffmpeg could not convert the file to MP3: ${tail}`);
  }
}

// ---- Orchestration ----

export type UploadApi = {
  getLimitMb: () => Promise<number>;
  titleExists: (title: string) => Promise<boolean>;
  presign: (body: { filesize: number; file_type: string }) => Promise<{ upload_id: string; object_name: string; part_urls: string[] }>;
  putPart: (url: string, data: Buffer) => Promise<string>;
  merge: (body: ReturnType<typeof buildMergeBody>) => Promise<unknown>;
  confirm: (body: Record<string, unknown>) => Promise<any>;
  tag: (fileId: string, tagId: string) => Promise<unknown>;
};

export type UploadDeps = {
  api: UploadApi;
  probeDurationSec: (filePath: string) => Promise<number | null>;
  transcodeToMp3: (input: string, output: string) => Promise<void>;
  log: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  serial: () => string;
};

export type UploadResult = {
  id: string;
  tagged: boolean;
  title: string;
  fileType: "MP3";
  transcoded: boolean;
  sizeBytes: number;
  parts: number;
  durationSec: number | null;
  file: any;
};

export type UploadOptions = {
  title?: string;
  tagId?: string;
  allowDuplicate?: boolean;
};

async function readSlice(filePath: string, start: number, end: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(end - start);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === buf.length ? buf : buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export function extractFileId(file: any): string {
  const f = file?.data_file || file?.data || file;
  return String(f?.id || f?.file_id || "");
}

export async function uploadAudioFile(filePath: string, opts: UploadOptions, deps: UploadDeps): Promise<UploadResult> {
  const abs = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new UploadError("FILE_NOT_FOUND", `No such file: ${abs}`);
  }
  if (!stat.isFile()) throw new UploadError("FILE_NOT_FOUND", `Not a file: ${abs}`);

  const title = (opts.title ?? defaultTitle(abs)).trim();
  if (!title) throw new UploadError("INVALID_ARGUMENT", "The title is empty.");

  const limitMb = await deps.api.getLimitMb();
  validateSize(stat.size, limitMb);

  if (!opts.allowDuplicate && (await deps.api.titleExists(title))) {
    throw new UploadError(
      "DUPLICATE",
      `Plaud already has a file titled "${title}". Pass --title with a different name, or --allow-duplicate.`,
    );
  }

  const isMp3 = path.extname(abs).toLowerCase() === ".mp3";
  let uploadPath = abs;
  let tmpDir: string | null = null;
  try {
    if (!isMp3) {
      // Refuse an over-long or empty source before spending minutes converting it.
      const sourceDuration = await deps.probeDurationSec(abs);
      validateDuration(sourceDuration);
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plaud-upload-"));
      uploadPath = path.join(tmpDir, "upload.mp3");
      deps.log(`Converting ${path.basename(abs)} to MP3 (mono, 16 kHz), like the web app...`);
      await deps.transcodeToMp3(abs, uploadPath);
    }

    const durationSec = await deps.probeDurationSec(uploadPath);
    if (durationSec === null) deps.log("Could not read the duration (ffprobe not found); skipping the length check.");
    validateDuration(durationSec);

    const size = (await fs.stat(uploadPath)).size;
    const parts = splitParts(size);

    deps.log(`Requesting upload (${(size / 1024 / 1024).toFixed(1)} MB, ${parts.length} part${parts.length === 1 ? "" : "s"})...`);
    const presigned = await deps.api.presign(buildPresignBody(size));
    if (presigned.part_urls.length !== parts.length) {
      throw new UploadError(
        "UPLOAD_FAILED",
        `Plaud returned ${presigned.part_urls.length} upload URLs for ${parts.length} parts. Aborting.`,
      );
    }

    const etags: string[] = new Array(parts.length);
    let next = 0;
    let done = 0;
    let failure: unknown = null;
    const worker = async () => {
      while (failure === null) {
        const i = next++;
        if (i >= parts.length) return;
        const part = parts[i];
        try {
          const data = await readSlice(uploadPath, part.start, part.end);
          etags[i] = await putWithRetry(deps, presigned.part_urls[i], data, part.partNumber, () => failure !== null);
        } catch (err) {
          failure ??= err;
          return;
        }
        done++;
        deps.log(`Uploaded part ${done}/${parts.length} (${Math.floor((done / parts.length) * 100)}%)`);
      }
    };
    // allSettled: wait for every worker to stop before cleaning up or reporting.
    await Promise.allSettled(Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, worker));
    if (failure !== null) throw failure;

    deps.log("Finalizing...");
    await deps.api.merge(buildMergeBody({ uploadId: presigned.upload_id, objectName: presigned.object_name, etags }));

    const startTimeMs = Math.floor(stat.mtimeMs) || deps.now();
    const confirmBody = buildConfirmBody({
      uploadId: presigned.upload_id,
      objectName: presigned.object_name,
      title,
      startTimeMs,
      timezoneHours: localTimezoneHours(),
      serialNumber: deps.serial(),
      tagId: opts.tagId,
    });
    let file: any;
    try {
      file = await deps.api.confirm(confirmBody);
    } catch (err: any) {
      // The upload may have gone through even though the answer did not arrive. Do not invite a blind retry.
      throw new UploadError(
        "CONFIRM_UNCERTAIN",
        `Plaud did not confirm the upload (${err?.message || err}). The file may already exist: run \`plaud files list\` and look for "${title}" before retrying.`,
      );
    }
    const id = extractFileId(file);
    if (!id) throw new UploadError("UPLOAD_FAILED", "Plaud confirmed the upload but returned no file id.", { data: file });

    let tagged = false;
    if (opts.tagId) {
      try {
        await deps.api.tag(id, opts.tagId);
        tagged = true;
      } catch (err: any) {
        deps.log(`Uploaded, but tagging failed (${err?.message || err}). Use \`plaud files tags add ${opts.tagId} ${id}\`.`);
      }
    }

    return { id, tagged, title, fileType: "MP3", transcoded: !isMp3, sizeBytes: size, parts: parts.length, durationSec, file: file?.data_file || file?.data || file };
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function putWithRetry(deps: UploadDeps, url: string, data: Buffer, partNumber: number, cancelled: () => boolean): Promise<string> {
  let lastErr: any;
  for (let attempt = 0; attempt <= PART_RETRIES; attempt++) {
    if (cancelled()) throw new UploadError("UPLOAD_NETWORK_ERROR", "Stopped because another part failed.");
    try {
      return cleanEtag(await deps.api.putPart(url, data));
    } catch (err: any) {
      lastErr = err;
      if (attempt < PART_RETRIES) {
        deps.log(`Part ${partNumber} failed (${err?.message || err}); retrying...`);
        await deps.sleep(500 * 2 ** attempt);
      }
    }
  }
  throw new UploadError("UPLOAD_NETWORK_ERROR", `Part ${partNumber} failed after ${PART_RETRIES} retries: ${lastErr?.message || lastErr}`);
}

export function newSerial(): string {
  return randomUUID();
}
