import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearStore,
  findDuplicateGroups,
  loadStoreIndex,
  putRecordingSnapshot,
  resolveStorePaths,
  searchStore,
  StoreClearSafetyError,
  verifyStore,
} from "../src/store.js";

async function withTempStore<T>(fn: (storeDir: string) => Promise<T>): Promise<T> {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "plaud-store-test-"));
  try {
    return await fn(storeDir);
  } finally {
    await fs.rm(storeDir, { recursive: true, force: true });
  }
}

function recording({
  id,
  name,
  content,
  speakers = ["A", "B"],
}: {
  id: string;
  name: string;
  content: string;
  speakers?: string[];
}) {
  const start = Date.UTC(2026, 0, 2, 3, 4, 5);
  const file = {
    id,
    filename: name,
    start_time: start,
    edit_time: start,
    duration: 120_000,
  };
  const details = {
    id,
    filename: name,
    start_time: start,
    edit_time: start,
    duration: 120_000,
    ai_content: "Synthetic summary about planning and follow-up.",
    trans_result: [
      { start_time: 0, speaker: speakers[0] || "Speaker 1", content },
      { start_time: 10_000, speaker: speakers[1] || speakers[0] || "Speaker 2", content: "Follow-up item captured." },
    ],
  };
  return { file, details };
}

test("local store keeps rename as a new snapshot while reusing transcript content", async () => {
  await withTempStore(async (storeDir) => {
    const paths = resolveStorePaths(storeDir);
    const first = recording({ id: "rec_1", name: "Original name", content: "Discuss fundraising plan." });
    const second = recording({ id: "rec_1", name: "Renamed in app", content: "Discuss fundraising plan." });

    const one = await putRecordingSnapshot({ paths, file: first.file, details: first.details });
    const repeat = await putRecordingSnapshot({ paths, file: first.file, details: first.details });
    const renamed = await putRecordingSnapshot({ paths, file: second.file, details: second.details });

    assert.equal(one.changed, true);
    assert.equal(repeat.changed, false);
    assert.equal(renamed.changed, true);
    assert.notEqual(one.snapshotHash, renamed.snapshotHash);
    assert.equal(one.snapshot.hashes.transcriptText, renamed.snapshot.hashes.transcriptText);

    const index = await loadStoreIndex(paths);
    assert.equal(Object.keys(index.recordings).length, 1);
    assert.equal(index.recordings.rec_1.snapshots.length, 2);
    assert.equal(index.recordings.rec_1.currentSnapshotHash, renamed.snapshotHash);
  });
});

test("local search returns current snapshots without snippets by default", async () => {
  await withTempStore(async (storeDir) => {
    const paths = resolveStorePaths(storeDir);
    const first = recording({ id: "rec_1", name: "Board prep", content: "Discuss fundraising plan." });
    const second = recording({ id: "rec_2", name: "Product sync", content: "Discuss search and filtering." });
    await putRecordingSnapshot({ paths, file: first.file, details: first.details });
    await putRecordingSnapshot({ paths, file: second.file, details: second.details });

    const result = await searchStore({ paths, query: "fundraising", limit: 5 });

    assert.equal(result.totalIndexed, 2);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, "rec_1");
    assert.equal(result.items[0].snippet, null);
    assert.equal(result.coverage.exhaustive, false);
    assert.equal(result.coverage.mode, "text");
    assert.deepEqual(result.coverage.fieldsSearched, ["name", "transcript", "summary", "tags", "speakers"]);
    assert.equal(result.coverage.riskFactors.candidateRecordsBeforeLimit, 1);
    assert.equal(result.coverage.riskFactors.truncated, false);
    assert.match(result.coverage.warnings.join("\n"), /candidates, not proof of exhaustive corpus coverage/);
  });
});

test("local search coverage reports generic speaker risk", async () => {
  await withTempStore(async (storeDir) => {
    const paths = resolveStorePaths(storeDir);
    const first = recording({
      id: "rec_1",
      name: "Interview with known title",
      content: "Discuss candidate background.",
      speakers: ["Speaker 1"],
    });
    await putRecordingSnapshot({ paths, file: first.file, details: first.details });

    const result = await searchStore({ paths, query: "candidate", limit: 5 });

    assert.equal(result.coverage.riskFactors.genericSpeakerRecords, 1);
    assert.match(result.coverage.warnings.join("\n"), /unlabeled or generic speakers/);
  });
});

test("local search coverage reports when result limit is reached", async () => {
  await withTempStore(async (storeDir) => {
    const paths = resolveStorePaths(storeDir);
    const first = recording({ id: "rec_1", name: "Planning 1", content: "Discuss recall coverage." });
    const second = recording({ id: "rec_2", name: "Planning 2", content: "Discuss recall coverage." });
    await putRecordingSnapshot({ paths, file: first.file, details: first.details });
    await putRecordingSnapshot({ paths, file: second.file, details: second.details });

    const result = await searchStore({ paths, query: "recall coverage", limit: 1 });

    assert.equal(result.items.length, 1);
    assert.equal(result.coverage.riskFactors.candidateRecordsBeforeLimit, 2);
    assert.equal(result.coverage.riskFactors.returnedLimit, 1);
    assert.equal(result.coverage.riskFactors.truncated, true);
    assert.match(result.coverage.warnings.join("\n"), /result limit was reached/);
  });
});

test("local search coverage warns on risky query shapes", async () => {
  await withTempStore(async (storeDir) => {
    const paths = resolveStorePaths(storeDir);
    const first = recording({ id: "rec_1", name: "Planning", content: "Discuss project context." });
    await putRecordingSnapshot({ paths, file: first.file, details: first.details });

    const result = await searchStore({ paths, query: "Speaker 1 Al project", limit: 5 });
    const warnings = result.coverage.warnings.join("\n");

    assert.match(warnings, /generic speaker\/unknown terms/);
    assert.match(warnings, /very short terms or aliases/);
    assert.match(warnings, /Multi-term fuzzy search/);
  });
});

test("local search includes snippets only when requested", async () => {
  await withTempStore(async (storeDir) => {
    const paths = resolveStorePaths(storeDir);
    const first = recording({ id: "rec_1", name: "Board prep", content: "Discuss fundraising plan." });
    await putRecordingSnapshot({ paths, file: first.file, details: first.details });

    const result = await searchStore({ paths, query: "fundraising", limit: 5, includeSnippets: true });

    assert.equal(result.items.length, 1);
    assert.match(result.items[0].snippet || "", /fundraising/i);
  });
});

test("duplicate groups can be reported by normalized transcript text", async () => {
  await withTempStore(async (storeDir) => {
    const paths = resolveStorePaths(storeDir);
    const first = recording({ id: "rec_1", name: "One", content: "Same content." });
    const second = recording({ id: "rec_2", name: "Two", content: "Same content." });
    const third = recording({ id: "rec_3", name: "Three", content: "Different content." });
    await putRecordingSnapshot({ paths, file: first.file, details: first.details });
    await putRecordingSnapshot({ paths, file: second.file, details: second.details });
    await putRecordingSnapshot({ paths, file: third.file, details: third.details });

    const dupes = await findDuplicateGroups({ paths, by: "text" });
    const verify = await verifyStore(paths);

    assert.equal(dupes.groups.length, 1);
    assert.deepEqual(
      dupes.groups[0].items.map((item) => item.id).sort(),
      ["rec_1", "rec_2"],
    );
    assert.equal(verify.ok, true);
  });
});

test("clearStore refuses non-store directories unless explicitly overridden", async () => {
  await withTempStore(async (storeDir) => {
    const paths = resolveStorePaths(storeDir);
    await fs.mkdir(storeDir, { recursive: true });

    await assert.rejects(() => clearStore(paths), StoreClearSafetyError);

    const result = await clearStore(paths, { allowUnsafeMissingIndex: true });
    assert.equal(result.removed, true);
  });
});

test("clearStore can remove an indexed local store", async () => {
  await withTempStore(async (storeDir) => {
    const paths = resolveStorePaths(storeDir);
    const first = recording({ id: "rec_1", name: "Board prep", content: "Discuss fundraising plan." });
    await putRecordingSnapshot({ paths, file: first.file, details: first.details });

    const result = await clearStore(paths);

    assert.equal(result.removed, true);
    await assert.rejects(() => fs.stat(storeDir));
  });
});
