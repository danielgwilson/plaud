import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContentConfig,
  buildPrivateCreateBody,
  chooseMode,
  describeConsequence,
  parseExpiry,
  parseRecipients,
  ShareInputError,
  summarizePrivate,
  summarizePublic,
} from "../src/share.js";

const notes = [{ data_id: "sum-1", data_type: "auto_sum_note" }, { data_id: "n2", data_type: "mark_note" }];

test("content config shares nothing unless asked", () => {
  assert.throws(() => buildContentConfig({ content: [], notes }), /Nothing is shared by default/);
  assert.deepEqual(buildContentConfig({ content: ["audio,transcript"], notes }), { audio: true, transcript: true, highlights: 0, overview: false, notes: [] });
  assert.deepEqual(buildContentConfig({ content: ["summary"], notes }).notes, ["sum-1"]);
  assert.deepEqual(buildContentConfig({ content: ["transcript"], noteIds: ["n2", "n2", "sum-1"], notes }).notes, ["n2", "sum-1"]);
  assert.throws(() => buildContentConfig({ content: ["bogus"], notes }), ShareInputError);
  assert.throws(() => buildContentConfig({ content: ["summary"], notes: [] }), /no summary/);
  assert.throws(() => buildContentConfig({ content: ["transcript"], noteIds: ["ghost"], notes }), /No note "ghost"/);
  assert.deepEqual(buildContentConfig({ content: [], noteIds: ["n2"], notes }).notes, ["n2"], "a note alone is enough");
});

test("mode: private by default, public only with the flag, never both", () => {
  assert.deepEqual(chooseMode({ to: ["A@B.co"], isPublic: false, yes: true }), { mode: "private", recipients: ["a@b.co"] });
  assert.deepEqual(chooseMode({ to: [], isPublic: true, yes: true }), { mode: "public" });
  assert.throws(() => chooseMode({ to: [], isPublic: false, yes: true }), /--to <email>/);
  assert.throws(() => chooseMode({ to: ["a@b.co"], isPublic: true, yes: true }), /not both/);
});

test("recipients are validated and de-duplicated", () => {
  assert.deepEqual(parseRecipients(["a@b.co, C@d.io", "a@b.co"]), ["a@b.co", "c@d.io"]);
  for (const bad of ["x", "a@b", "a b@c.co", "@c.co"]) assert.throws(() => parseRecipients([bad]), ShareInputError, bad);
  assert.throws(() => parseRecipients([]), /at least one/);
});

test("expiry is RFC3339 in the future; a bare date is the end of that day in UTC", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  assert.equal(parseExpiry("2026-12-31", now), "2026-12-31T23:59:59Z");
  assert.equal(parseExpiry("2026-12-31T17:00:00Z", now), "2026-12-31T17:00:00Z");
  assert.equal(parseExpiry("2026-12-31T17:00:00.500Z", now), "2026-12-31T17:00:00Z");
  assert.throws(() => parseExpiry("2026-01-01", now), /past/);
  assert.throws(() => parseExpiry("next week", now), /not a date/);
});

test("request bodies and summaries match the API", () => {
  const cfg = buildContentConfig({ content: ["audio"], notes });
  assert.deepEqual(buildPrivateCreateBody("f1", cfg, ["a@b.co"]).recipients, [{ contact_type: "email", contact: "a@b.co" }]);
  assert.match(describeConsequence({ mode: "public" }, cfg), /PUBLIC.*the audio/);
  assert.match(describeConsequence({ mode: "private", recipients: ["a@b.co"] }, cfg), /EMAIL a@b\.co/);
  assert.equal(summarizePublic(null), null);
  assert.equal(summarizePublic({ share_url: "u", share_key: "k", expire_at: null, content_config: {} })!.url, "u");
  assert.deepEqual(summarizePrivate({ recipients: [{ recipient_id: "r", contact: "a@b.co", status: "invited" }] }), { recipients: [{ recipientId: "r", contact: "a@b.co", status: "invited" }] });
  assert.equal(summarizePrivate(null), null);
});
