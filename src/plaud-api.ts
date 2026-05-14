import { readConfig } from "./config.js";

const BASE_URL = "https://api.plaud.ai";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

type PlaudApiError = Error & { status?: number; data?: unknown };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanToken(token: string): string {
  return String(token || "")
    .trim()
    .replace(/^bearer\s+/i, "");
}

export async function resolveAuthToken(): Promise<string> {
  if (process.env.PLAUD_AUTH_TOKEN) return cleanToken(process.env.PLAUD_AUTH_TOKEN);

  const config = await readConfig();
  if (config?.authToken) return cleanToken(config.authToken);

  return "";
}

async function readJsonOrThrow(response: Response): Promise<any> {
  let data: any;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (response.ok) return data;

  const detail =
    (data && typeof data === "object" && (data.detail || data.msg || data.message)) || "";
  const message = detail ? String(detail) : `HTTP ${response.status} ${response.statusText}`;
  const error = new Error(message) as PlaudApiError;
  error.status = response.status;
  error.data = data;
  throw error;
}

export async function plaudRequest({
  token,
  endpoint,
  method = "GET",
  body,
  timeoutMs = 30_000,
  retries = 4,
}: {
  token: string;
  endpoint: string;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}): Promise<any> {
  const url = `${BASE_URL}${endpoint}`;
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "app-platform": "web",
    authorization: `bearer ${cleanToken(token)}`,
    "content-type": "application/json",
    dnt: "1",
    "edit-from": "web",
    origin: "https://app.plaud.ai",
    referer: "https://app.plaud.ai/",
    "user-agent": BROWSER_USER_AGENT,
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      return await readJsonOrThrow(response);
    } catch (error: any) {
      const isLast = attempt === retries;
      const status = error?.status as number | undefined;
      const transient =
        error?.name === "AbortError" ||
        status === 429 ||
        (typeof status === "number" && status >= 500);

      if (isLast || !transient) throw error;

      const backoffMs = Math.min(10_000, 500 * 2 ** attempt);
      await sleep(backoffMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  // unreachable
  throw new Error("Request failed");
}

export async function getMe({ token }: { token: string }): Promise<any> {
  return await plaudRequest({ token, endpoint: "/user/me", timeoutMs: 15_000, retries: 1 });
}

export async function getRecordingTempUrls({ token, id }: { token: string; id: string }): Promise<any> {
  if (!id) throw new Error("Missing recording id");
  return await plaudRequest({ token, endpoint: `/file/temp-url/${encodeURIComponent(String(id))}` });
}

function parseFileListResponse(listResponse: any): any[] {
  if (!listResponse || typeof listResponse !== "object") return [];

  if (listResponse.detail && String(listResponse.detail).toLowerCase().includes("token")) {
    throw new Error("Auth token expired/invalid. Re-run `plaud auth set`.");
  }

  if (listResponse.status !== undefined && listResponse.status !== 0) {
    throw new Error(listResponse.msg || listResponse.message || "API error");
  }

  const candidates = [
    listResponse.data_file_list,
    listResponse.files,
    listResponse.data,
    listResponse.dataFileList,
    listResponse.list,
    listResponse.file_list,
    listResponse.items,
    listResponse.records,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  return [];
}

export async function listRecordings({
  token,
  includeTrash = false,
  sortBy = "start_time",
  isDesc = true,
  pageSize = 200,
  max = Infinity,
}: {
  token: string;
  includeTrash?: boolean;
  sortBy?: string;
  isDesc?: boolean;
  pageSize?: number;
  max?: number;
}): Promise<any[]> {
  const isTrash = includeTrash ? 2 : 0;
  const recordings: any[] = [];
  let skip = 0;

  while (recordings.length < max) {
    const limit = Math.min(pageSize, max - recordings.length);
    const res = await plaudRequest({
      token,
      endpoint: `/file/simple/web?skip=${skip}&limit=${limit}&is_trash=${isTrash}&sort_by=${encodeURIComponent(
        String(sortBy || "start_time"),
      )}&is_desc=${isDesc ? "true" : "false"}`,
    });
    const batch = parseFileListResponse(res);
    if (batch.length === 0) break;
    recordings.push(...batch);
    skip += batch.length;
    if (batch.length < limit) break;
  }

  return recordings;
}

export async function listRecordingsPage({
  token,
  includeTrash = false,
  sortBy = "start_time",
  isDesc = true,
  skip = 0,
  limit = 25,
}: {
  token: string;
  includeTrash?: boolean;
  sortBy?: string;
  isDesc?: boolean;
  skip?: number;
  limit?: number;
}): Promise<any[]> {
  const isTrash = includeTrash ? 2 : 0;
  const res = await plaudRequest({
    token,
    endpoint: `/file/simple/web?skip=${Number(skip || 0)}&limit=${Number(limit || 0)}&is_trash=${isTrash}&sort_by=${encodeURIComponent(
      String(sortBy || "start_time"),
    )}&is_desc=${isDesc ? "true" : "false"}`,
  });
  return parseFileListResponse(res);
}

export async function getRecordingDetailsBatch({ token, ids }: { token: string; ids: string[] }): Promise<any[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const res = await plaudRequest({
    token,
    endpoint: "/file/list?support_mul_summ=true",
    method: "POST",
    body: ids,
  });

  if (res?.status === 0 && Array.isArray(res?.data_file_list)) return res.data_file_list;
  return [];
}

function assertApiOk(res: any): void {
  if (!res || typeof res !== "object") throw new Error("API error");
  if (typeof (res as any).status === "number" && (res as any).status !== 0) {
    throw new Error((res as any).msg || (res as any).message || "API error");
  }
}

export async function trashFiles({ token, ids }: { token: string; ids: string[] }): Promise<any> {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("Missing file id(s)");
  const res = await plaudRequest({ token, endpoint: "/file/trash/", method: "POST", body: ids });
  assertApiOk(res);
  return res;
}

export async function untrashFiles({ token, ids }: { token: string; ids: string[] }): Promise<any> {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("Missing file id(s)");
  const res = await plaudRequest({ token, endpoint: "/file/untrash/", method: "POST", body: ids });
  assertApiOk(res);
  return res;
}

export type PlaudTag = { id: string; name: string; icon?: string; color?: string };

function parseTagListResponse(res: any): PlaudTag[] {
  assertApiOk(res);
  const list = res?.data_filetag_list;
  if (Array.isArray(list)) return list as PlaudTag[];
  const nested = res?.data?.data_filetag_list || res?.data?.list || res?.data?.items;
  if (Array.isArray(nested)) return nested as PlaudTag[];
  return [];
}

export async function listTags({ token }: { token: string }): Promise<PlaudTag[]> {
  const res = await plaudRequest({ token, endpoint: "/filetag/" });
  return parseTagListResponse(res);
}

export async function updateTags({
  token,
  fileIds,
  filetagId,
}: {
  token: string;
  fileIds: string[];
  filetagId: string;
}): Promise<any> {
  if (!Array.isArray(fileIds) || fileIds.length === 0) throw new Error("Missing file id(s)");
  const res = await plaudRequest({
    token,
    endpoint: "/file/update-tags",
    method: "POST",
    body: { file_id_list: fileIds, filetag_id: String(filetagId ?? "") },
  });
  assertApiOk(res);
  return res;
}

export async function triggerTransSumm({
  token,
  fileId,
  payload,
}: {
  token: string;
  fileId: string;
  payload: Record<string, unknown>;
}): Promise<any> {
  if (!fileId) throw new Error("Missing file id");
  const res = await plaudRequest({
    token,
    endpoint: `/ai/transsumm/${encodeURIComponent(String(fileId))}`,
    method: "POST",
    body: payload,
  });
  assertApiOk(res);
  return res;
}

export type PlaudRunningTask = {
  file_id: string;
  task_id: string;
  task_status: number;
  task_type: string;
  sum_type?: string;
  sum_type_type?: string;
  [k: string]: unknown;
};

export async function listRunningTasks({ token }: { token: string }): Promise<PlaudRunningTask[]> {
  const res = await plaudRequest({ token, endpoint: "/ai/file-task-status" });
  assertApiOk(res);
  const list = res?.data?.file_status_list;
  return Array.isArray(list) ? (list as PlaudRunningTask[]) : [];
}

export async function patchFile({
  token,
  fileId,
  body,
}: {
  token: string;
  fileId: string;
  body: Record<string, unknown>;
}): Promise<any> {
  if (!fileId) throw new Error("Missing file id");
  const res = await plaudRequest({
    token,
    endpoint: `/file/${encodeURIComponent(String(fileId))}`,
    method: "PATCH",
    body,
  });
  assertApiOk(res);
  return res;
}
