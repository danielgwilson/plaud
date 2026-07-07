import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import envPaths from "env-paths";
import MiniSearch from "minisearch";
import { formatTranscript } from "./recordings-format.js";

const STORE_VERSION = 1;

export type StoreWhat = {
  json: boolean;
  transcript: boolean;
  summary: boolean;
};

export type StorePaths = {
  root: string;
  blobsDir: string;
  snapshotsDir: string;
  indexPath: string;
};

export type BlobEntry = {
  hash: string;
  kind: "details" | "transcript" | "summary";
  path: string;
  bytes: number;
  createdAt: string;
};

export type RecordingEntry = {
  id: string;
  provider: "plaud";
  currentSnapshotHash: string;
  snapshots: string[];
  firstSeenAt: string;
  lastSeenAt: string;
};

export type SnapshotEntry = {
  version: 1;
  provider: "plaud";
  id: string;
  snapshotHash: string;
  syncedAt: string;
  metadata: {
    name: string;
    createdAtMs: number | null;
    createdAt: string | null;
    modifiedAtMs: number | null;
    modifiedAt: string | null;
    durationMs: number | null;
    tags: string[];
    speakers: string[];
    trashed: boolean | null;
  };
  hashes: {
    snapshot: string;
    metadata: string;
    details: string;
    transcript: string | null;
    transcriptText: string | null;
    summary: string | null;
  };
  blobs: {
    details: string | null;
    transcript: string | null;
    summary: string | null;
  };
};

export type StoreIndex = {
  version: 1;
  updatedAt: string | null;
  recordings: Record<string, RecordingEntry>;
  snapshots: Record<string, SnapshotEntry>;
  blobs: Record<string, BlobEntry>;
};

export type PutSnapshotResult = {
  id: string;
  snapshotHash: string;
  changed: boolean;
  currentChanged: boolean;
  blobWrites: number;
  snapshot: SnapshotEntry;
};

type SearchDocument = {
  id: string;
  snapshotHash: string;
  name: string;
  transcript: string;
  summary: string;
  tags: string;
  speakers: string;
  createdAt: string | null;
  createdAtMs: number | null;
  modifiedAt: string | null;
  durationMs: number | null;
};

export type SearchResult = {
  id: string;
  snapshotHash: string;
  name: string;
  score: number | null;
  createdAt: string | null;
  modifiedAt: string | null;
  durationMs: number | null;
  snippet: string | null;
  hashes: SnapshotEntry["hashes"];
};

function defaultStoreRoot(): string {
  const paths = envPaths("plaud", { suffix: "" });
  return path.join(paths.data, "store");
}

export function resolveStorePaths(storeDir?: string | null): StorePaths {
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  const xdgRoot = xdgData ? path.join(xdgData, "plaud", "store") : null;
  const root = path.resolve(storeDir || process.env.PLAUD_STORE_DIR || xdgRoot || defaultStoreRoot());
  return {
    root,
    blobsDir: path.join(root, "blobs", "sha256"),
    snapshotsDir: path.join(root, "snapshots"),
    indexPath: path.join(root, "index.json"),
  };
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Best effort on filesystems that do not support POSIX permissions.
  }
}

export async function ensureStore(paths: StorePaths): Promise<void> {
  await ensurePrivateDir(paths.root);
  await ensurePrivateDir(paths.blobsDir);
  await ensurePrivateDir(paths.snapshotsDir);
}

function emptyIndex(): StoreIndex {
  return {
    version: STORE_VERSION,
    updatedAt: null,
    recordings: {},
    snapshots: {},
    blobs: {},
  };
}

export async function loadStoreIndex(paths: StorePaths): Promise<StoreIndex> {
  try {
    const raw = await fs.readFile(paths.indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== STORE_VERSION) return emptyIndex();
    return {
      version: STORE_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      recordings: parsed.recordings && typeof parsed.recordings === "object" ? parsed.recordings : {},
      snapshots: parsed.snapshots && typeof parsed.snapshots === "object" ? parsed.snapshots : {},
      blobs: parsed.blobs && typeof parsed.blobs === "object" ? parsed.blobs : {},
    };
  } catch {
    return emptyIndex();
  }
}

async function saveStoreIndex(paths: StorePaths, index: StoreIndex): Promise<void> {
  await ensureStore(paths);
  index.updatedAt = new Date().toISOString();
  await fs.writeFile(paths.indexPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.chmod(paths.indexPath, 0o600);
  } catch {
    // ignore
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
  return sha256Text(stableStringify(value));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function getNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function msToIso(ms: number | null): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getCreatedMs(file: any, details: any): number | null {
  return getNum(details?.start_time) ?? getNum(file?.start_time) ?? null;
}

function getModifiedMs(file: any, details: any): number | null {
  return getNum(details?.edit_time) ?? getNum(file?.edit_time) ?? null;
}

function getDurationMs(file: any, details: any): number | null {
  return (
    getNum(details?.duration) ??
    getNum(details?.duration_ms) ??
    getNum(details?.audio_duration) ??
    getNum(details?.audio_duration_ms) ??
    getNum(file?.duration) ??
    getNum(file?.duration_ms) ??
    getNum(file?.audio_duration) ??
    getNum(file?.audio_duration_ms) ??
    null
  );
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item: any) => {
          if (typeof item === "string") return item;
          return item?.name || item?.label || item?.title || item?.value || "";
        })
        .map((s) => String(s).trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function extractTags(file: any, details: any): string[] {
  return asStringArray(details?.tags ?? details?.tag_list ?? file?.tags ?? file?.tag_list);
}

function extractSpeakers(details: any): string[] {
  const segments = Array.isArray(details?.trans_result) ? details.trans_result : [];
  const names: string[] = segments
    .map((seg: any) => seg?.speaker || seg?.speaker_name || seg?.speakerName || seg?.role || "")
    .map((s: unknown) => String(s).trim())
    .filter((s: string) => Boolean(s));
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

function getTrashed(file: any, details: any): boolean | null {
  const value = details?.is_trash ?? details?.trashed ?? file?.is_trash ?? file?.trashed;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return null;
}

function blobRelPath(kind: BlobEntry["kind"], hash: string, ext: string): string {
  return path.join("blobs", "sha256", kind, hash.slice(0, 2), `${hash}.${ext}`);
}

async function writeBlob({
  paths,
  index,
  kind,
  hash,
  ext,
  content,
}: {
  paths: StorePaths;
  index: StoreIndex;
  kind: BlobEntry["kind"];
  hash: string;
  ext: string;
  content: string;
}): Promise<{ relPath: string; wrote: boolean }> {
  const key = `${kind}:${hash}`;
  const relPath = blobRelPath(kind, hash, ext);
  const existing = index.blobs[key];
  const targetRelPath = existing?.path || relPath;
  const absPath = path.join(paths.root, targetRelPath);
  if (existing) {
    try {
      await fs.stat(absPath);
      return { relPath: existing.path, wrote: false };
    } catch {
      // Recreate the missing blob below and keep the existing index key.
    }
  }

  {
    await ensurePrivateDir(path.dirname(absPath));
    await fs.writeFile(absPath, content, { mode: 0o600 });
    try {
      await fs.chmod(absPath, 0o600);
    } catch {
      // ignore
    }
    index.blobs[key] = {
      hash,
      kind,
      path: targetRelPath,
      bytes: Buffer.byteLength(content),
      createdAt: new Date().toISOString(),
    };
    return { relPath: targetRelPath, wrote: true };
  }
}

function parseWhat(value: string | undefined): StoreWhat {
  const raw = String(value || "json,transcript,summary")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const set = new Set(raw.length ? raw : ["json", "transcript", "summary"]);
  return {
    json: set.has("json") || set.has("details"),
    transcript: set.has("transcript") || set.has("txt"),
    summary: set.has("summary") || set.has("md") || set.has("ai"),
  };
}

export function parseStoreWhat(value: string | undefined): StoreWhat {
  return parseWhat(value);
}

export async function putRecordingSnapshot({
  paths,
  file,
  details,
  what,
}: {
  paths: StorePaths;
  file: any;
  details: any;
  what?: StoreWhat;
}): Promise<PutSnapshotResult> {
  await ensureStore(paths);
  const index = await loadStoreIndex(paths);
  const syncedAt = new Date().toISOString();
  const id = String(details?.id || file?.id || "").trim();
  if (!id) throw new Error("Recording id missing");

  const name = String(details?.filename || details?.name || file?.filename || file?.name || "").trim();
  const transcriptText = formatTranscript(details?.trans_result);
  const normalizedTranscript = normalizeText(transcriptText);
  const summaryText = details?.ai_content ? String(details.ai_content) : "";
  const detailsJson = `${JSON.stringify(details ?? {}, null, 2)}\n`;
  const detailsHash = sha256Text(detailsJson);
  const transcriptHash = transcriptText.trim() ? canonicalHash(details?.trans_result ?? transcriptText) : null;
  const transcriptTextHash = normalizedTranscript ? sha256Text(normalizedTranscript) : null;
  const summaryHash = summaryText.trim() ? sha256Text(summaryText) : null;
  const metadata = {
    name,
    createdAtMs: getCreatedMs(file, details),
    createdAt: msToIso(getCreatedMs(file, details)),
    modifiedAtMs: getModifiedMs(file, details),
    modifiedAt: msToIso(getModifiedMs(file, details)),
    durationMs: getDurationMs(file, details),
    tags: extractTags(file, details),
    speakers: extractSpeakers(details),
    trashed: getTrashed(file, details),
  };
  const metadataHash = canonicalHash(metadata);
  const snapshotHash = canonicalHash({
    provider: "plaud",
    id,
    metadata,
    detailsHash,
    transcriptHash,
    transcriptTextHash,
    summaryHash,
  });

  const selected = what || parseStoreWhat(undefined);
  let blobWrites = 0;
  let detailsPath: string | null = null;
  let transcriptPath: string | null = null;
  let summaryPath: string | null = null;

  if (selected.json) {
    const written = await writeBlob({ paths, index, kind: "details", hash: detailsHash, ext: "json", content: detailsJson });
    detailsPath = written.relPath;
    if (written.wrote) blobWrites += 1;
  }
  if (selected.transcript && transcriptHash && transcriptText.trim()) {
    const written = await writeBlob({ paths, index, kind: "transcript", hash: transcriptHash, ext: "txt", content: `${transcriptText}\n` });
    transcriptPath = written.relPath;
    if (written.wrote) blobWrites += 1;
  }
  if (selected.summary && summaryHash && summaryText.trim()) {
    const written = await writeBlob({ paths, index, kind: "summary", hash: summaryHash, ext: "md", content: `${summaryText.trim()}\n` });
    summaryPath = written.relPath;
    if (written.wrote) blobWrites += 1;
  }

  const snapshot: SnapshotEntry = {
    version: STORE_VERSION,
    provider: "plaud",
    id,
    snapshotHash,
    syncedAt,
    metadata,
    hashes: {
      snapshot: snapshotHash,
      metadata: metadataHash,
      details: detailsHash,
      transcript: transcriptHash,
      transcriptText: transcriptTextHash,
      summary: summaryHash,
    },
    blobs: {
      details: detailsPath,
      transcript: transcriptPath,
      summary: summaryPath,
    },
  };

  const changed = !index.snapshots[snapshotHash];
  if (changed) {
    const snapshotRel = path.join("snapshots", id, `${snapshotHash}.json`);
    const snapshotAbs = path.join(paths.root, snapshotRel);
    await ensurePrivateDir(path.dirname(snapshotAbs));
    await fs.writeFile(snapshotAbs, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    try {
      await fs.chmod(snapshotAbs, 0o600);
    } catch {
      // ignore
    }
    index.snapshots[snapshotHash] = snapshot;
  }

  const existing = index.recordings[id];
  const currentChanged = existing?.currentSnapshotHash !== snapshotHash;
  if (!existing) {
    index.recordings[id] = {
      id,
      provider: "plaud",
      currentSnapshotHash: snapshotHash,
      snapshots: [snapshotHash],
      firstSeenAt: syncedAt,
      lastSeenAt: syncedAt,
    };
  } else {
    existing.currentSnapshotHash = snapshotHash;
    existing.lastSeenAt = syncedAt;
    if (!existing.snapshots.includes(snapshotHash)) existing.snapshots.push(snapshotHash);
  }

  await saveStoreIndex(paths, index);
  return { id, snapshotHash, changed, currentChanged, blobWrites, snapshot };
}

function currentSnapshots(index: StoreIndex, includeAllSnapshots = false): SnapshotEntry[] {
  if (includeAllSnapshots) return Object.values(index.snapshots);
  return Object.values(index.recordings)
    .map((recording) => index.snapshots[recording.currentSnapshotHash])
    .filter((snapshot): snapshot is SnapshotEntry => !!snapshot);
}

async function readBlobText(paths: StorePaths, relPath: string | null): Promise<string> {
  if (!relPath) return "";
  try {
    return await fs.readFile(path.join(paths.root, relPath), "utf8");
  } catch {
    return "";
  }
}

function parseDateMs(value: string | undefined): number | null {
  if (!value) return null;
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function snapshotMatchesWindow(snapshot: SnapshotEntry, fromMs: number | null, toMs: number | null): boolean {
  const ms = snapshot.metadata.createdAtMs ?? snapshot.metadata.modifiedAtMs;
  if (!ms) return true;
  if (fromMs && ms < fromMs) return false;
  if (toMs && ms > toMs) return false;
  return true;
}

async function buildSearchDocuments(paths: StorePaths, index: StoreIndex, includeAllSnapshots: boolean): Promise<SearchDocument[]> {
  const snapshots = currentSnapshots(index, includeAllSnapshots);
  const docs: SearchDocument[] = [];
  for (const snapshot of snapshots) {
    const transcript = await readBlobText(paths, snapshot.blobs.transcript);
    const summary = await readBlobText(paths, snapshot.blobs.summary);
    docs.push({
      id: snapshot.id,
      snapshotHash: snapshot.snapshotHash,
      name: snapshot.metadata.name,
      transcript,
      summary,
      tags: snapshot.metadata.tags.join(" "),
      speakers: snapshot.metadata.speakers.join(" "),
      createdAt: snapshot.metadata.createdAt,
      createdAtMs: snapshot.metadata.createdAtMs,
      modifiedAt: snapshot.metadata.modifiedAt,
      durationMs: snapshot.metadata.durationMs,
    });
  }
  return docs;
}

function makeSnippet(doc: SearchDocument, query: string): string | null {
  const haystack = `${doc.name}\n${doc.summary}\n${doc.transcript}`.replace(/\s+/g, " ").trim();
  if (!haystack) return null;
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9_-]/gi, ""))
    .filter(Boolean);
  const lower = haystack.toLowerCase();
  const idx = terms.map((term) => lower.indexOf(term)).find((n) => n >= 0) ?? 0;
  const start = Math.max(0, idx - 80);
  const end = Math.min(haystack.length, idx + 180);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < haystack.length ? "..." : "";
  return `${prefix}${haystack.slice(start, end)}${suffix}`;
}

export async function searchStore({
  paths,
  query,
  limit = 20,
  from,
  to,
  includeAllSnapshots = false,
  listAll = false,
}: {
  paths: StorePaths;
  query?: string;
  limit?: number;
  from?: string;
  to?: string;
  includeAllSnapshots?: boolean;
  listAll?: boolean;
}): Promise<{ items: SearchResult[]; totalIndexed: number; storeDir: string }> {
  const index = await loadStoreIndex(paths);
  const fromMs = parseDateMs(from);
  const toMs = parseDateMs(to);
  const docs = (await buildSearchDocuments(paths, index, includeAllSnapshots)).filter((doc) => {
    const snapshot = index.snapshots[doc.snapshotHash];
    return snapshot ? snapshotMatchesWindow(snapshot, fromMs, toMs) : false;
  });
  const max = Math.max(0, limit);
  const docBySnapshot = new Map(docs.map((doc) => [doc.snapshotHash, doc]));

  if (listAll || !query?.trim()) {
    const sorted = docs.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)).slice(0, max);
    return {
      totalIndexed: docs.length,
      storeDir: paths.root,
      items: sorted.map((doc) => {
        const snapshot = index.snapshots[doc.snapshotHash];
        return {
          id: doc.id,
          snapshotHash: doc.snapshotHash,
          name: doc.name,
          score: null,
          createdAt: doc.createdAt,
          modifiedAt: doc.modifiedAt,
          durationMs: doc.durationMs,
          snippet: makeSnippet(doc, doc.name),
          hashes: snapshot.hashes,
        };
      }),
    };
  }

  const miniSearch = new MiniSearch<SearchDocument>({
    fields: ["name", "transcript", "summary", "tags", "speakers"],
    storeFields: ["id", "snapshotHash", "name", "createdAt", "modifiedAt", "durationMs"],
  });
  miniSearch.addAll(docs);
  const results = miniSearch.search(query, { prefix: true, fuzzy: 0.2 }).slice(0, max);
  return {
    totalIndexed: docs.length,
    storeDir: paths.root,
    items: results
      .map((result: any) => {
        const doc = docBySnapshot.get(String(result.snapshotHash));
        const snapshot = doc ? index.snapshots[doc.snapshotHash] : null;
        if (!doc || !snapshot) return null;
        return {
          id: doc.id,
          snapshotHash: doc.snapshotHash,
          name: doc.name,
          score: typeof result.score === "number" ? result.score : null,
          createdAt: doc.createdAt,
          modifiedAt: doc.modifiedAt,
          durationMs: doc.durationMs,
          snippet: makeSnippet(doc, query),
          hashes: snapshot.hashes,
        };
      })
      .filter((item): item is SearchResult => !!item),
  };
}

export function storeStatusFromIndex(paths: StorePaths, index: StoreIndex): {
  storeDir: string;
  recordings: number;
  snapshots: number;
  blobs: number;
  updatedAt: string | null;
} {
  return {
    storeDir: paths.root,
    recordings: Object.keys(index.recordings).length,
    snapshots: Object.keys(index.snapshots).length,
    blobs: Object.keys(index.blobs).length,
    updatedAt: index.updatedAt,
  };
}

export async function getStoreStatus(paths: StorePaths) {
  const index = await loadStoreIndex(paths);
  return storeStatusFromIndex(paths, index);
}

export async function findDuplicateGroups({
  paths,
  by = "content",
  includeAllSnapshots = false,
}: {
  paths: StorePaths;
  by?: string;
  includeAllSnapshots?: boolean;
}) {
  const index = await loadStoreIndex(paths);
  const groups = new Map<string, SnapshotEntry[]>();
  for (const snapshot of currentSnapshots(index, includeAllSnapshots)) {
    let hash: string | null = null;
    if (by === "snapshot") hash = snapshot.hashes.snapshot;
    else if (by === "metadata") hash = snapshot.hashes.metadata;
    else if (by === "details") hash = snapshot.hashes.details;
    else if (by === "transcript") hash = snapshot.hashes.transcript;
    else if (by === "text" || by === "transcript-text") hash = snapshot.hashes.transcriptText;
    else if (by === "summary") hash = snapshot.hashes.summary;
    else hash = snapshot.hashes.transcriptText || snapshot.hashes.transcript || snapshot.hashes.summary;
    if (!hash) continue;
    const existing = groups.get(hash) || [];
    existing.push(snapshot);
    groups.set(hash, existing);
  }
  return {
    storeDir: paths.root,
    by,
    groups: Array.from(groups.entries())
      .filter(([, snapshots]) => snapshots.length > 1)
      .map(([hash, snapshots]) => ({
        hash,
        count: snapshots.length,
        items: snapshots.map((snapshot) => ({
          id: snapshot.id,
          snapshotHash: snapshot.snapshotHash,
          name: snapshot.metadata.name,
          createdAt: snapshot.metadata.createdAt,
          modifiedAt: snapshot.metadata.modifiedAt,
        })),
      })),
  };
}

export async function verifyStore(paths: StorePaths) {
  const index = await loadStoreIndex(paths);
  const missing: Array<{ kind: string; hash: string; path: string }> = [];
  for (const blob of Object.values(index.blobs)) {
    try {
      await fs.stat(path.join(paths.root, blob.path));
    } catch {
      missing.push({ kind: blob.kind, hash: blob.hash, path: blob.path });
    }
  }
  for (const snapshot of Object.values(index.snapshots)) {
    const snapshotRel = path.join("snapshots", snapshot.id, `${snapshot.snapshotHash}.json`);
    try {
      await fs.stat(path.join(paths.root, snapshotRel));
    } catch {
      missing.push({ kind: "snapshot", hash: snapshot.snapshotHash, path: snapshotRel });
    }
  }
  return {
    ...storeStatusFromIndex(paths, index),
    ok: missing.length === 0,
    missing,
  };
}

export async function clearStore(paths: StorePaths): Promise<{ storeDir: string; removed: boolean }> {
  await fs.rm(paths.root, { recursive: true, force: true });
  return { storeDir: paths.root, removed: true };
}
