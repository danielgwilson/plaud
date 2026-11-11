import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  buildConfirmBody,
  buildMergeBody,
  buildPresignBody,
  cleanEtag,
  defaultTitle,
  extractFileId,
  ffmpegArgs,
  knownStatusFrom,
  PART_SIZE,
  splitParts,
  uploadAudioFile,
  UploadError,
  uploadErrorForStatus,
  validateDuration,
  validateSize,
  type UploadDeps,
} from "../src/upload.js";
import { putPart, unwrapUploadResponse } from "../src/upload-api.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plaud-upload-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("splitParts cuts 5 MB parts and a single part for small files", () => {
  assert.deepEqual(splitParts(1000), [{ index: 0, partNumber: 1, start: 0, end: 1000 }]);
  assert.equal(splitParts(PART_SIZE).length, 1);
  const parts = splitParts(PART_SIZE * 2 + 1);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[2], { index: 2, partNumber: 3, start: PART_SIZE * 2, end: PART_SIZE * 2 + 1 });
  // parts are contiguous and cover the whole file
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].start, parts[i - 1].end);
  assert.throws(() => splitParts(0), (e: any) => e instanceof UploadError && e.code === "INVALID_FORMAT");
});

test("request bodies match the web app's field names", () => {
  assert.deepEqual(buildPresignBody(123), { filesize: 123, file_type: "MP3" });
  assert.deepEqual(buildMergeBody({ uploadId: "u", objectName: "o", etags: ['"aa"', "bb"] }), {
    upload_id: "u",
    object_name: "o",
    parts: [
      { Etag: "aa", PartNumber: 1 },
      { Etag: "bb", PartNumber: 2 },
    ],
  });
  const confirm = buildConfirmBody({
    uploadId: "u",
    objectName: "o",
    title: "Interview",
    startTimeMs: 1_700_000_123_456,
    timezoneHours: -8,
    serialNumber: "serial-1",
  });
  assert.deepEqual(confirm, {
    upload_id: "u",
    object_name: "o",
    scene: 101,
    is_tmp: 0,
    support_mul_summ: true,
    file_type: "MP3",
    filename: "Interview",
    start_time: 1_700_000_123_456,
    session_id: 1_700_000_123,
    serial_number: "serial-1",
    timezone: -8,
  });
  assert.deepEqual(
    buildConfirmBody({ uploadId: "u", objectName: "o", title: "t", startTimeMs: 1000, timezoneHours: 0, serialNumber: "s", tagId: "tag1" }).filetag_id_list,
    ["tag1"],
  );
  assert.equal(cleanEtag('"abc"'), "abc");
});

test("ffmpeg arguments match the web app's MP3 conversion", () => {
  assert.deepEqual(ffmpegArgs("in.m4a", "out.mp3").slice(-11), [
    "-vn", "-c:a", "libmp3lame", "-ar", "16000", "-ac", "1", "-qscale:a", "0", "-ignore_unknown", "out.mp3",
  ]);
});

test("status codes map to stable error codes", () => {
  assert.equal(uploadErrorForStatus(-2).code, "DUPLICATE");
  assert.equal(uploadErrorForStatus(-3).code, "INVALID_FORMAT");
  assert.equal(uploadErrorForStatus(-4).code, "FILE_TOO_LARGE");
  assert.equal(uploadErrorForStatus(-7).code, "TOO_SHORT");
  assert.equal(uploadErrorForStatus(-99, "boom").code, "UPLOAD_FAILED");
  assert.equal(knownStatusFrom({ data: { status: -7 } }), -7);
  assert.equal(knownStatusFrom({ status: 500 }), null);
  assert.throws(() => unwrapUploadResponse({ status: -3, msg: "bad" }), (e: any) => e.code === "INVALID_FORMAT");
  assert.deepEqual(unwrapUploadResponse({ status: 0, upload_id: "u" }), { status: 0, upload_id: "u" });
  assert.deepEqual(unwrapUploadResponse({ data: { upload_id: "u" } }), { upload_id: "u" });
});

test("duration and size limits follow the web app", () => {
  assert.doesNotThrow(() => validateDuration(null));
  assert.doesNotThrow(() => validateDuration(1));
  assert.throws(() => validateDuration(0.4), (e: any) => e.code === "TOO_SHORT");
  assert.doesNotThrow(() => validateDuration(5 * 3600));
  assert.throws(() => validateDuration(5 * 3600 + 2), (e: any) => e.code === "TOO_LONG");
  assert.doesNotThrow(() => validateSize(500 * 1024 * 1024, 500));
  assert.throws(() => validateSize(500 * 1024 * 1024 + 1, 500), (e: any) => e.code === "FILE_TOO_LARGE");
  assert.equal(defaultTitle("/a/b/My Interview.final.m4a"), "My Interview.final");
});

test("extractFileId reads the id from either response shape", () => {
  assert.equal(extractFileId({ data_file: { id: "f1" } }), "f1");
  assert.equal(extractFileId({ data: { id: "f2" } }), "f2");
  assert.equal(extractFileId({ id: "f3" }), "f3");
  assert.equal(extractFileId({}), "");
});

type Calls = { presign: any[]; puts: Array<{ url: string; size: number }>; merge: any[]; confirm: any[]; logs: string[]; transcoded: string[]; tags: string[][] };

function fakeDeps(overrides: { durationSec?: number | null; failPutsOnce?: number; exists?: boolean; limitMb?: number; confirmFails?: boolean } = {}): { deps: UploadDeps; calls: Calls } {
  const calls: Calls = { presign: [], puts: [], merge: [], confirm: [], logs: [], transcoded: [], tags: [] };
  let putFailures = overrides.failPutsOnce ?? 0;
  const deps: UploadDeps = {
    api: {
      getLimitMb: async () => overrides.limitMb ?? 500,
      titleExists: async () => overrides.exists ?? false,
      presign: async (body) => {
        calls.presign.push(body);
        const n = Math.ceil(body.filesize / PART_SIZE);
        return { upload_id: "up-1", object_name: "obj-1", part_urls: Array.from({ length: n }, (_, i) => `https://s3.example/part-${i + 1}`) };
      },
      putPart: async (url, data) => {
        if (putFailures > 0) {
          putFailures--;
          throw new Error("socket hang up");
        }
        calls.puts.push({ url, size: data.length });
        return `"etag-${url.split("-").pop()}"`;
      },
      merge: async (body) => {
        calls.merge.push(body);
        return {};
      },
      tag: async (fileId, tagId) => {
        calls.tags.push([fileId, tagId]);
        return {};
      },
      confirm: async (body) => {
        if (overrides.confirmFails) throw new Error("timeout");
        calls.confirm.push(body);
        return { data_file: { id: "new-file-id", filename: body.filename } };
      },
    },
    probeDurationSec: async () => (overrides.durationSec === undefined ? 120 : overrides.durationSec),
    transcodeToMp3: async (_input, output) => {
      calls.transcoded.push(output);
      await fs.writeFile(output, Buffer.alloc(PART_SIZE + 10, 1));
    },
    log: (m) => calls.logs.push(m),
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    serial: () => "serial-fixed",
  };
  return { deps, calls };
}

test("uploadAudioFile sends a small MP3 as one part without transcoding", async () => {
  await withTempDir(async (tmp) => {
    const file = path.join(tmp, "Weekly sync.mp3");
    await fs.writeFile(file, Buffer.alloc(2048, 7));
    const { deps, calls } = fakeDeps();
    const result = await uploadAudioFile(file, {}, deps);
    assert.equal(result.id, "new-file-id");
    assert.equal(result.title, "Weekly sync");
    assert.equal(result.transcoded, false);
    assert.equal(result.parts, 1);
    assert.deepEqual(calls.presign, [{ filesize: 2048, file_type: "MP3" }]);
    assert.deepEqual(calls.puts, [{ url: "https://s3.example/part-1", size: 2048 }]);
    assert.deepEqual(calls.merge[0].parts, [{ Etag: "etag-1", PartNumber: 1 }]);
    assert.equal(calls.confirm[0].filename, "Weekly sync");
    assert.equal(calls.confirm[0].serial_number, "serial-fixed");
    assert.equal(calls.transcoded.length, 0);
  });
});

test("uploadAudioFile transcodes other formats and uploads multipart in order", async () => {
  await withTempDir(async (tmp) => {
    const file = path.join(tmp, "interview.m4a");
    await fs.writeFile(file, Buffer.alloc(100));
    const { deps, calls } = fakeDeps();
    const result = await uploadAudioFile(file, { title: "Candidate interview", tagId: "tag-9" }, deps);
    assert.equal(result.transcoded, true);
    assert.equal(result.parts, 2);
    assert.equal(calls.transcoded.length, 1);
    assert.deepEqual(calls.puts.map((p) => p.size).sort((a, b) => a - b), [10, PART_SIZE]);
    // the merge list is ordered by part number regardless of upload order
    assert.deepEqual(calls.merge[0].parts, [
      { Etag: "etag-1", PartNumber: 1 },
      { Etag: "etag-2", PartNumber: 2 },
    ]);
    assert.equal(calls.confirm[0].filename, "Candidate interview");
    assert.deepEqual(calls.confirm[0].filetag_id_list, ["tag-9"]);
    // temp transcode is cleaned up
    await assert.rejects(fs.stat(calls.transcoded[0]));
  });
});

test("uploadAudioFile retries a failed part, then gives up with UPLOAD_NETWORK_ERROR", async () => {
  await withTempDir(async (tmp) => {
    const file = path.join(tmp, "a.mp3");
    await fs.writeFile(file, Buffer.alloc(10));
    const retry = fakeDeps({ failPutsOnce: 2 });
    await uploadAudioFile(file, {}, retry.deps);
    assert.equal(retry.calls.puts.length, 1);
    assert.equal(retry.calls.logs.filter((l) => l.includes("retrying")).length, 2);

    const dead = fakeDeps({ failPutsOnce: 99 });
    await assert.rejects(uploadAudioFile(file, {}, dead.deps), (e: any) => e.code === "UPLOAD_NETWORK_ERROR");
    assert.equal(dead.calls.merge.length, 0);
    assert.equal(dead.calls.confirm.length, 0);
  });
});

test("uploadAudioFile rejects before uploading: too short, duplicate title, too large, missing file", async () => {
  await withTempDir(async (tmp) => {
    const file = path.join(tmp, "a.mp3");
    await fs.writeFile(file, Buffer.alloc(10));

    const short = fakeDeps({ durationSec: 0.3 });
    await assert.rejects(uploadAudioFile(file, {}, short.deps), (e: any) => e.code === "TOO_SHORT");
    assert.equal(short.calls.presign.length, 0);

    const dupe = fakeDeps({ exists: true });
    await assert.rejects(uploadAudioFile(file, {}, dupe.deps), (e: any) => e.code === "DUPLICATE");
    assert.equal(dupe.calls.presign.length, 0);
    await uploadAudioFile(file, { allowDuplicate: true }, dupe.deps);
    assert.equal(dupe.calls.presign.length, 1);

    const big = fakeDeps({ limitMb: 0.000001 });
    await assert.rejects(uploadAudioFile(file, {}, big.deps), (e: any) => e.code === "FILE_TOO_LARGE");

    await assert.rejects(uploadAudioFile(path.join(tmp, "nope.mp3"), {}, fakeDeps().deps), (e: any) => e.code === "FILE_NOT_FOUND");
  });
});

test("uploadAudioFile skips the length check when the duration is unknown", async () => {
  await withTempDir(async (tmp) => {
    const file = path.join(tmp, "a.mp3");
    await fs.writeFile(file, Buffer.alloc(10));
    const { deps, calls } = fakeDeps({ durationSec: null });
    const result = await uploadAudioFile(file, {}, deps);
    assert.equal(result.durationSec, null);
    assert.ok(calls.logs.some((l) => l.includes("skipping the length check")));
  });
});

test("putPart sends no Plaud auth header and returns the ETag", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), init };
    return new Response(null, { status: 200, headers: { etag: '"abc123"' } });
  }) as typeof fetch;
  try {
    const etag = await putPart("https://s3.example/part-1?sig=x", Buffer.from("hello"));
    assert.equal(etag, '"abc123"');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured?.init?.method, "PUT");
  const headers = (captured?.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["content-type"], undefined);
});

test("uploadAudioFile stops other workers when a part fails", async () => {
  await withTempDir(async (tmp) => {
    const file = path.join(tmp, "big.mp3");
    await fs.writeFile(file, Buffer.alloc(PART_SIZE * 20));
    const { deps, calls } = fakeDeps();
    let started = 0;
    deps.api.putPart = async (url) => {
      started++;
      if (url.endsWith("part-2")) throw new Error("403");
      await new Promise((r) => setTimeout(r, 5));
      calls.puts.push({ url, size: 0 });
      return '"e"';
    };
    await assert.rejects(uploadAudioFile(file, {}, deps), (e: any) => e.code === "UPLOAD_NETWORK_ERROR");
    const after = started;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(started, after, "no part starts after the call has returned");
    assert.ok(started < 20);
    assert.equal(calls.confirm.length, 0);
  });
});

test("uploadAudioFile reports an unconfirmed upload as CONFIRM_UNCERTAIN and tags after confirm", async () => {
  await withTempDir(async (tmp) => {
    const file = path.join(tmp, "a.mp3");
    await fs.writeFile(file, Buffer.alloc(10));
    await assert.rejects(uploadAudioFile(file, {}, fakeDeps({ confirmFails: true }).deps), (e: any) => e.code === "CONFIRM_UNCERTAIN" && /plaud files list/.test(e.message));
    const tagged = fakeDeps();
    const r = await uploadAudioFile(file, { tagId: "t1" }, tagged.deps);
    assert.equal(r.tagged, true);
    assert.deepEqual(tagged.calls.tags, [["new-file-id", "t1"]]);
  });
});
