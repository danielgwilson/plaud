import { listRecordings, plaudRequest, updateTags } from "./plaud-api.js";
import {
  DEFAULT_LIMIT_MB,
  knownStatusFrom,
  newSerial,
  probeDurationSec,
  transcodeToMp3,
  UploadError,
  uploadErrorForStatus,
  type UploadApi,
  type UploadDeps,
} from "./upload.js";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Plaud endpoints answer either `{ status: 0, ...fields }` or `{ data: { ...fields } }`. */
export function unwrapUploadResponse(res: any): any {
  if (res && typeof res === "object" && typeof res.status === "number" && res.status !== 0) {
    throw uploadErrorForStatus(res.status, res.msg || res.message);
  }
  if (res && typeof res === "object" && res.data && typeof res.data === "object" && !Array.isArray(res.data)) return res.data;
  return res;
}

async function call(token: string, endpoint: string, body: unknown, retries: number, timeoutMs = 30_000): Promise<any> {
  try {
    return unwrapUploadResponse(await plaudRequest({ token, endpoint, method: "POST", body, retries, timeoutMs }));
  } catch (err: any) {
    if (err instanceof UploadError) throw err;
    const status = knownStatusFrom(err);
    if (status !== null) throw uploadErrorForStatus(status, err?.message);
    throw err;
  }
}

/** PUT one part to its presigned URL. Presigned URLs carry their own auth: no Plaud token is sent. */
export async function putPart(url: string, data: Buffer): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000);
  try {
    const response = await fetch(url, {
      method: "PUT",
      body: data as unknown as BodyInit,
      headers: { "user-agent": BROWSER_USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("Storage did not return an ETag for the part.");
    return etag;
  } finally {
    clearTimeout(timeout);
  }
}

export function createUploadApi(token: string): UploadApi {
  return {
    async getLimitMb() {
      try {
        const res = await plaudRequest({ token, endpoint: "/others/web-config", retries: 1, timeoutMs: 15_000 });
        const n = Number(res?.upload_limit_size ?? res?.data?.upload_limit_size);
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT_MB;
      } catch {
        return DEFAULT_LIMIT_MB;
      }
    },
    async titleExists(title) {
      // The web app compares against the names it has loaded; do the same against the full list.
      const files = await listRecordings({ token });
      const wanted = title.trim().toLowerCase();
      return files.some((f: any) => String(f?.filename || "").trim().toLowerCase() === wanted);
    },
    async presign(body) {
      const res = await call(token, "/file/get_upload_presigned_url", body, 2);
      if (!res?.upload_id || !res?.object_name || !Array.isArray(res?.part_urls) || res.part_urls.length === 0) {
        throw new UploadError("UPLOAD_FAILED", "Plaud did not return upload URLs.");
      }
      return { upload_id: String(res.upload_id), object_name: String(res.object_name), part_urls: res.part_urls.map(String) };
    },
    putPart,
    async merge(body) {
      return await call(token, "/file/merge_multipart", body, 2, 120_000);
    },
    async confirm(body) {
      // No automatic retry: a retried confirm could create a second file.
      return await call(token, "/file/confirm_upload", body, 0, 120_000);
    },
    async tag(fileId, tagId) {
      return await updateTags({ token, fileIds: [fileId], filetagId: tagId });
    },
  };
}

export function createUploadDeps(token: string, log: (msg: string) => void): UploadDeps {
  return {
    api: createUploadApi(token),
    probeDurationSec,
    transcodeToMp3,
    log,
    sleep,
    now: () => Date.now(),
    serial: newSerial,
  };
}
