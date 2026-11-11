import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNoteDeleteBody,
  buildNoteUpdateBody,
  buildRenameBody,
  checkExpectVersion,
  parseExpectVersion,
  parseSegmentIndex,
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
  assert.equal(planTranscriptReplace(segs, "hello", "hello").changed, 0);
  assert.throws(() => planTranscriptReplace([{ content: "whole" }], "whole", ""), /blank a whole segment/);
  assert.deepEqual(parseSegmentIndex("3"), 3);
  for (const bad of ["", "1e1", "0x1", "-1", "a"]) assert.throws(() => parseSegmentIndex(bad), EditInputError);
  assert.equal(parseExpectVersion(undefined), undefined);
  assert.throws(() => parseExpectVersion("x"), EditInputError);
  assert.equal(checkExpectVersion({ version: 3 }, 3, "f"), 3);
  assert.throws(() => checkExpectVersion({ version: 3 }, 4, "f"), /expected 4/);
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
  const memo = { data_id: "n3", data_type: "mark_note", data_title: "Old", data_content: "kept" };
  assert.equal(buildNoteUpdateBody("f1", memo, { title: "T" }).note_content, "kept");
  assert.throws(() => findNote(notes, "zzz"), /Available: n1/);
  assert.throws(() => buildNoteUpdateBody("f1", note, {}), /Nothing to change/);
  assert.throws(() => buildNoteUpdateBody("f1", note, { content: "  " }), /notes delete/);
  assert.throws(() => buildNoteUpdateBody("f1", note, { title: "x" }), /title is fixed/);
  assert.throws(() => buildNoteDeleteBody(note), /auto summary/);
  assert.deepEqual(buildNoteDeleteBody({ data_id: "n2", data_type: "mark_note", data_content: "c" }), { note_id: "n2", note_type: "mark_note", note_content: "c" });
});
