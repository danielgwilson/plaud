import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSegmentAssignments,
  parseSpeakerMap,
  parseSummaryMap,
  planSpeakerApply,
  SpeakerApplyInputError,
} from "../src/speakers.js";

// All names and text below are synthetic.
function fixture() {
  return [
    { start_time: 0, end_time: 1000, content: "Hello", speaker: "Speaker 1", original_speaker: "Speaker 1", segment_uid: "u1" },
    { start_time: 1000, end_time: 2000, content: "Hi there", speaker: "Speaker 2", original_speaker: "Speaker 2", segment_uid: "u2" },
    { start_time: 2000, end_time: 3000, content: "Right", speaker: "Speaker 1", original_speaker: "Speaker 1", segment_uid: "u3" },
    { start_time: 3000, end_time: 4000, content: "Sure", speaker: "Speaker 10", original_speaker: "Speaker 10" },
  ];
}

const SUMMARY = "Speaker 1 opened. Speaker 2 agreed. Speaker 10 left. **Speaker  1** closed.";

test("map renames segments by original speaker and rewrites the summary", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    aiContent: SUMMARY,
    map: { "Speaker 1": "Ada Lovelace", "Speaker 2": "Alan Turing" },
  });
  assert.deepEqual(
    plan.transResult.map((s) => s.speaker),
    ["Ada Lovelace", "Alan Turing", "Ada Lovelace", "Speaker 10"],
  );
  assert.equal(plan.transResult[0].original_speaker, "Speaker 1");
  assert.equal(plan.changed, 3);
  assert.equal(plan.skippedRenamed, 0);
  assert.equal(plan.totalSegments, 4);
  assert.deepEqual(plan.unmatchedLabels, []);
  assert.equal(plan.summaryReplacements, 3);
  assert.equal(plan.aiContent, "Ada Lovelace opened. Alan Turing agreed. Speaker 10 left. **Ada Lovelace** closed.");
});

test("planSpeakerApply does not mutate its input", () => {
  const input = fixture();
  planSpeakerApply({ transResult: input, aiContent: SUMMARY, map: { "Speaker 1": "Ada Lovelace" } });
  assert.deepEqual(input, fixture());
});

test("segments override map per segment and match by uid or exact times", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    map: { "Speaker 1": "Ada Lovelace" },
    segments: [
      { start_time: 2000, end_time: 3000, speaker: "Grace Hopper" },
      { segment_uid: "u2", speaker: "Alan Turing" },
    ],
  });
  assert.deepEqual(
    plan.transResult.map((s) => s.speaker),
    ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Speaker 10"],
  );
  assert.equal(plan.changed, 3);
  assert.equal(plan.unmatchedSegments, 0);
});

test("unmatched labels and segments are reported", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    map: { "Speaker 9": "Nobody", "Speaker 1": "Ada Lovelace" },
    segments: [
      { start_time: 5, end_time: 6, speaker: "Nobody" },
      { segment_uid: "missing", speaker: "Nobody" },
    ],
  });
  assert.deepEqual(plan.unmatchedLabels, ["Speaker 9"]);
  assert.equal(plan.unmatchedSegments, 2);
  assert.equal(plan.changed, 2);
});

test("guard skips segments a human already named; --overwrite replaces them", () => {
  const typed = fixture();
  typed[0].speaker = "Ada (typed)";
  const map = { "Speaker 1": "Ada Lovelace" };

  const guarded = planSpeakerApply({ transResult: typed, aiContent: SUMMARY, map });
  assert.equal(guarded.transResult[0].speaker, "Ada (typed)");
  assert.equal(guarded.transResult[2].speaker, "Ada Lovelace");
  assert.equal(guarded.changed, 1);
  assert.equal(guarded.skippedRenamed, 1);
  // The label no longer maps to a single name, so the summary is left alone.
  assert.equal(guarded.summaryReplacements, 0);
  assert.equal(guarded.aiContent, SUMMARY);

  const forced = planSpeakerApply({ transResult: typed, aiContent: SUMMARY, map, overwrite: true });
  assert.equal(forced.transResult[0].speaker, "Ada Lovelace");
  assert.equal(forced.changed, 2);
  assert.equal(forced.skippedRenamed, 0);
  assert.equal(forced.summaryReplacements, 2);
});

test("summary rewrite never touches Speaker 10 when mapping Speaker 1", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    aiContent: "Speaker 10 and Speaker 1 and Speaker 100 and xSpeaker 1.",
    map: { "Speaker 1": "Ada Lovelace" },
  });
  assert.equal(plan.aiContent, "Speaker 10 and Ada Lovelace and Speaker 100 and xSpeaker 1.");
  assert.equal(plan.summaryReplacements, 1);
});

test("summary rewrite is a single pass, so swapped names do not chain", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    aiContent: "Speaker 1 asked, Speaker 2 answered.",
    map: { "Speaker 1": "Speaker 2", "Speaker 2": "Speaker 1" },
  });
  assert.equal(plan.aiContent, "Speaker 2 asked, Speaker 1 answered.");
  assert.equal(plan.summaryReplacements, 2);
});

test("summary label whitespace does not span newlines", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    aiContent: "## Speaker\n1. Intro\nSpeaker\t1 spoke.",
    map: { "Speaker 1": "Ada Lovelace" },
  });
  assert.equal(plan.aiContent, "## Speaker\n1. Intro\nAda Lovelace spoke.");
});

test("a label split across two names leaves the summary untouched", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    aiContent: SUMMARY,
    map: { "Speaker 1": "Ada Lovelace", "Speaker 2": "Alan Turing" },
    segments: [{ segment_uid: "u3", speaker: "Grace Hopper" }],
  });
  assert.deepEqual(
    plan.transResult.map((s) => s.speaker),
    ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Speaker 10"],
  );
  // Speaker 2 maps cleanly and is rewritten; the split Speaker 1 is not.
  assert.equal(plan.summaryReplacements, 1);
  assert.equal(plan.aiContent, "Speaker 1 opened. Alan Turing agreed. Speaker 10 left. **Speaker  1** closed.");
});

test("a second identical run changes nothing", () => {
  const input = { map: { "Speaker 1": "Ada Lovelace", "Speaker 2": "Alan Turing" } };
  const first = planSpeakerApply({ transResult: fixture(), aiContent: SUMMARY, ...input });
  const second = planSpeakerApply({ transResult: first.transResult, aiContent: first.aiContent, ...input });
  assert.equal(second.changed, 0);
  assert.equal(second.skippedRenamed, 0);
  assert.equal(second.alreadyApplied, 3);
  assert.equal(second.summaryReplacements, 0);
  assert.deepEqual(second.transResult, first.transResult);
  assert.equal(second.aiContent, first.aiContent);
});

test("non-string ai_content is left alone", () => {
  for (const aiContent of [undefined, null, 42, { a: "Speaker 1" }, ["Speaker 1"]]) {
    const plan = planSpeakerApply({ transResult: fixture(), aiContent, map: { "Speaker 1": "Ada Lovelace" } });
    assert.equal(plan.changed, 2);
    assert.equal(plan.summaryReplacements, 0);
    assert.equal(plan.aiContent, aiContent);
  }
});

test("summary: false skips the summary", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    aiContent: SUMMARY,
    map: { "Speaker 1": "Ada Lovelace" },
    summary: false,
  });
  assert.equal(plan.changed, 2);
  assert.equal(plan.summaryReplacements, 0);
  assert.equal(plan.aiContent, SUMMARY);
});

test("a JSON-string summary stays valid JSON when the name needs escaping", () => {
  const aiContent = JSON.stringify({ title: "Speaker 1 call", points: ["Speaker 1 spoke"] });
  const plan = planSpeakerApply({ transResult: fixture(), aiContent, map: { "Speaker 1": 'Ada "AL" Lovelace' } });
  assert.equal(plan.summaryReplacements, 2);
  assert.deepEqual(JSON.parse(plan.aiContent as string), {
    title: 'Ada "AL" Lovelace call',
    points: ['Ada "AL" Lovelace spoke'],
  });
});

test("names containing $ patterns are inserted literally", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    aiContent: "Speaker 1 spoke.",
    map: { "Speaker 1": "A$&B$1" },
  });
  assert.equal(plan.aiContent, "A$&B$1 spoke.");
});

test("segments without original_speaker are not matched by map and are guarded by segment", () => {
  const segs = [
    { start_time: 0, end_time: 10, speaker: "Mystery", content: "x" },
    { start_time: 10, end_time: 20, speaker: "", content: "y" },
  ];
  const mapOnly = planSpeakerApply({ transResult: segs, map: { Mystery: "Ada Lovelace" } });
  assert.equal(mapOnly.changed, 0);
  assert.deepEqual(mapOnly.unmatchedLabels, ["Mystery"]);

  const bySegment = planSpeakerApply({
    transResult: segs,
    segments: [
      { start_time: 0, end_time: 10, speaker: "Ada Lovelace" },
      { start_time: 10, end_time: 20, speaker: "Alan Turing" },
    ],
  });
  assert.equal(bySegment.skippedRenamed, 1);
  assert.equal(bySegment.changed, 1);
  assert.equal(bySegment.transResult[1].speaker, "Alan Turing");
});

test("planSpeakerApply requires an assignment and rejects conflicting duplicates", () => {
  assert.throws(() => planSpeakerApply({ transResult: fixture() }), SpeakerApplyInputError);
  assert.throws(
    () =>
      planSpeakerApply({
        transResult: fixture(),
        segments: [
          { segment_uid: "u1", speaker: "Ada Lovelace" },
          { segment_uid: "u1", speaker: "Alan Turing" },
        ],
      }),
    /conflicting/,
  );
});

test("parseSpeakerMap validates shape and trims names", () => {
  assert.deepEqual(parseSpeakerMap({ "Speaker 1": "  Ada Lovelace " }), { "Speaker 1": "Ada Lovelace" });
  for (const bad of [null, [], "Speaker 1", 3, { "Speaker 1": 3 }, { "Speaker 1": "" }, { "Speaker 1": "   " }, { " ": "Ada" }]) {
    assert.throws(() => parseSpeakerMap(bad), SpeakerApplyInputError);
  }
});

test("parseSegmentAssignments validates shape", () => {
  assert.deepEqual(parseSegmentAssignments([{ start_time: 1, end_time: 2, speaker: "Ada" }, { segment_uid: "u9", speaker: "Alan" }]), [
    { start_time: 1, end_time: 2, speaker: "Ada" },
    { segment_uid: "u9", speaker: "Alan" },
  ]);
  const bad: unknown[] = [
    {},
    "x",
    [null],
    [{ start_time: 1, end_time: 2 }],
    [{ start_time: 1, end_time: 2, speaker: "" }],
    [{ start_time: 1, end_time: 2, speaker: 7 }],
    [{ start_time: "1", end_time: 2, speaker: "Ada" }],
    [{ start_time: 1, speaker: "Ada" }],
    [{ speaker: "Ada" }],
    [{ segment_uid: "", speaker: "Ada" }],
    [{ segment_uid: 5, speaker: "Ada" }],
  ];
  for (const b of bad) assert.throws(() => parseSegmentAssignments(b), SpeakerApplyInputError);
});

test("summaryMap alone rewrites the summary without touching segments", () => {
  const aiContent = "Ada Lovelace opened. Ada agreed with Alan. Adams left. **Ada Lovelace**'s notes.";
  const plan = planSpeakerApply({
    transResult: fixture(),
    aiContent,
    summaryMap: { "Ada Lovelace": "Speaker 1", Ada: "Speaker 1" },
  });
  assert.equal(plan.changed, 0);
  assert.deepEqual(plan.transResult, fixture());
  assert.equal(plan.summaryReplacements, 3);
  assert.equal(plan.aiContent, "Speaker 1 opened. Speaker 1 agreed with Alan. Adams left. **Speaker 1**'s notes.");
});

test("summaryMap wins over a derived label replacement and joins the same single pass", () => {
  const plan = planSpeakerApply({
    transResult: fixture(),
    aiContent: "Speaker 1 met Pat Lee.",
    map: { "Speaker 1": "Ada Lovelace" },
    summaryMap: { "Pat Lee": "Speaker 1" },
  });
  assert.equal(plan.changed, 2);
  assert.equal(plan.aiContent, "Ada Lovelace met Speaker 1.");
  assert.equal(plan.summaryReplacements, 2);
});

test("summaryMap cannot be combined with summary: false, and an empty request still fails", () => {
  assert.throws(
    () => planSpeakerApply({ transResult: fixture(), summaryMap: { Ada: "Speaker 1" }, summary: false }),
    SpeakerApplyInputError,
  );
  assert.throws(() => planSpeakerApply({ transResult: fixture(), summaryMap: {} }), SpeakerApplyInputError);
});

test("parseSummaryMap validates shape and trims replacements", () => {
  assert.deepEqual(parseSummaryMap({ "Pat Lee": "  Speaker 2 " }), { "Pat Lee": "Speaker 2" });
  for (const bad of [null, [], "Pat", 3, { Pat: 3 }, { Pat: "" }, { " ": "Speaker 2" }]) {
    assert.throws(() => parseSummaryMap(bad), SpeakerApplyInputError);
  }
});
