import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNoteDeleteBody,
  buildNoteUpdateBody,
  buildRenameBody,
  EditInputError,
  findNote,
  planSegmentEdit,
  planTranscriptReplace,
} from "../src/edit.js";

const segs = [
  { start_time: 0, end_time: 1000, content: "hello world", speaker: "Speaker 1" },
  { start_time: 1000, end_time: 2000, content: "goodbye world", speaker: "Speaker 2" },
];

test("rename body matches the web app's title edit", () => {
  assert.deepEqual(buildRenameBody("  New title "), { filename: "New title", extra_data: { actionData: { hasTitleEdit: true } } });
  assert.equal(buildRenameBody("t", 5).file_version, 5);
  assert.throws(() => buildRenameBody("   "), EditInputError);
});

test("segment edit changes only that segment's text", () => {
  const plan = planSegmentEdit(segs, 1, "see you");
  assert.equal(plan.changed, 1);
  assert.deepEqual(plan.segments[1], { start_time: 1000, end_time: 2000, content: "see you", speaker: "Speaker 2" });
  assert.deepEqual(plan.segments[0], segs[0]);
  assert.equal(segs[1].content, "goodbye world", "input is not mutated");
  assert.equal(planSegmentEdit(segs, 0, "hello world").changed, 0);
  assert.throws(() => planSegmentEdit(segs, 2, "x"), /0 to 1/);
  assert.throws(() => planSegmentEdit(segs, -1, "x"), EditInputError);
  assert.throws(() => planSegmentEdit(segs, 0, " "), EditInputError);
  assert.throws(() => planSegmentEdit([], 0, "x"), /no transcript/);
});

test("transcript replace is literal, reports each changed segment, and keeps the rest", () => {
  const plan = planTranscriptReplace(segs, "world", "there");
  assert.equal(plan.changed, 2);
  assert.deepEqual(plan.segments.map((s) => s.content), ["hello there", "goodbye there"]);
  assert.deepEqual(plan.changes[0], { index: 0, before: "hello world", after: "hello there" });
  assert.equal(planTranscriptReplace(segs, "nope", "x").changed, 0);
  assert.equal(planTranscriptReplace([{ content: "a.b" }, { content: "axb" }], "a.b", "Z").changed, 1, "no regex semantics");
  assert.throws(() => planTranscriptReplace(segs, "", "x"), EditInputError);
});

test("note bodies carry id, type, title and content", () => {
  const notes = [{ data_id: "n1", data_type: "auto_sum_note", data_title: "Summary", data_content: "old" }];
  const note = findNote(notes, "n1");
  assert.deepEqual(buildNoteUpdateBody("f1", note, { content: "new" }), {
    file_id: "f1",
    note_id: "n1",
    note_type: "auto_sum_note",
    note_title: "Summary",
    note_content: "new",
  });
  assert.equal(buildNoteUpdateBody("f1", note, { title: "T" }).note_content, "old");
  assert.deepEqual(buildNoteDeleteBody(note), { note_id: "n1", note_type: "auto_sum_note", note_content: "old" });
  assert.throws(() => findNote(notes, "zzz"), /Available: n1/);
  assert.throws(() => buildNoteUpdateBody("f1", note, {}), /Nothing to change/);
  assert.throws(() => buildNoteUpdateBody("f1", note, { content: "  " }), /notes delete/);
});
