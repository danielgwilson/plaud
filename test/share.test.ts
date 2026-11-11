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
  createPublicShareFlow,
  createPrivateShareFlow,
  ShareUncertainError,
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
  assert.deepEqual(chooseMode({ to: ["A@B.co"], isPublic: false }), { mode: "private", recipients: ["a@b.co"] });
  assert.deepEqual(chooseMode({ to: [], isPublic: true }), { mode: "public" });
  assert.throws(() => chooseMode({ to: [], isPublic: false }), /--to <email>/);
  assert.throws(() => chooseMode({ to: ["a@b.co"], isPublic: true }), /not both/);
});

test("recipients are validated and de-duplicated", () => {
  assert.deepEqual(parseRecipients(["a@b.co, C@d.io", "a@b.co"]), ["a@b.co", "c@d.io"]);
  for (const bad of ["x", "a@b", "a b@c.co", "@c.co", "mailto:ann@x.com", "ann@x.com.", "ann@x.com;", "ann@exаmple.com", "ann@-x.com"]) assert.throws(() => parseRecipients([bad]), ShareInputError, bad);
  assert.throws(() => parseRecipients([]), /at least one/);
});

test("expiry is an explicit date or zoned date-time in the future; a bare date is the end of that day in UTC", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  assert.equal(parseExpiry("2026-12-31", now), "2026-12-31T23:59:59Z");
  assert.equal(parseExpiry("2026-12-31T17:00:00Z", now), "2026-12-31T17:00:00Z");
  assert.equal(parseExpiry("2026-12-31T17:00:00.500Z", now), "2026-12-31T17:00:00Z");
  assert.equal(parseExpiry("2026-12-31T09:00:00-08:00", now), "2026-12-31T17:00:00Z");
  assert.throws(() => parseExpiry("2026-01-01", now), /past/);
  for (const bad of ["next week", "2026-12-31T17:00", "12/31/2026", "2027", "2026-02-30", "2026-13-01", ""]) {
    assert.throws(() => parseExpiry(bad, now), ShareInputError, JSON.stringify(bad));
  }
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
  assert.deepEqual(summarizePrivate({ weird: 1 }), { unrecognized: true, keys: ["weird"] }, "never reads as 'shared with nobody'");
});

function memoryApi(opts: { existing?: boolean; failCreate?: boolean; failExpiry?: boolean; ignoreDelete?: boolean; failReadAfterCreate?: boolean } = {}) {
  const calls: string[] = [];
  let link: any = opts.existing ? { share_url: "https://x/s/k::t", share_key: "k", expire_at: null, content_config: {} } : null;
  return {
    calls,
    api: {
      getPublic: async () => { calls.push("get"); return link; },
      createPublic: async (b: any) => { calls.push("create"); if (opts.failCreate) { if (!opts.failReadAfterCreate) link = { share_url: "https://x/s/k::t", share_key: "k", expire_at: null, content_config: b.content_config }; throw new Error("timeout"); } link = { share_url: "https://x/s/k::t", share_key: "k", expire_at: null, content_config: b.content_config }; return link; },
      setExpiry: async (at: string) => { calls.push("expiry"); if (opts.failExpiry) throw new Error("rejected"); link = { ...link, expire_at: at }; return link; },
      deletePublic: async () => { calls.push("delete"); if (!opts.ignoreDelete) link = null; },
      createPrivate: async (b: any) => { calls.push("private"); return { recipients: b.recipients.map((r: any, i: number) => ({ recipient_id: `r${i}`, contact: r.contact })) }; },
    },
  };
}
const cfg = { audio: false, transcript: true, highlights: 0 as const, overview: false, notes: [] };

test("public flow: refuses when a link exists, verifies expiry, removes the link when it fails", async () => {
  const existing = memoryApi({ existing: true });
  await assert.rejects(createPublicShareFlow(existing.api, "f1", cfg, null), /already has a public link/);
  assert.ok(!existing.calls.includes("create"));

  const ok = memoryApi();
  const out = await createPublicShareFlow(ok.api, "f1", cfg, "2099-12-31T23:59:59Z");
  assert.equal(out.expireAt, "2099-12-31T23:59:59Z");
  assert.ok(!ok.calls.includes("delete"));

  const failed = memoryApi({ failExpiry: true });
  await assert.rejects(createPublicShareFlow(failed.api, "f1", cfg, "2099-12-31T23:59:59Z"), (e: any) => e instanceof ShareUncertainError && e.stillShared === false && /link was removed/.test(e.message));
  assert.ok(failed.calls.includes("delete"));

  const stuck = memoryApi({ failExpiry: true, ignoreDelete: true });
  await assert.rejects(createPublicShareFlow(stuck.api, "f1", cfg, "2099-12-31T23:59:59Z"), (e: any) => e.stillShared === true && /revoke f1/.test(e.message));
});

test("public flow: a create that errors is settled from the server, and an expiry request removes a stray link", async () => {
  const withExpiry = memoryApi({ failCreate: true });
  await assert.rejects(createPublicShareFlow(withExpiry.api, "f1", cfg, "2099-12-31T23:59:59Z"), (e: any) => e.stillShared === false && /removed/.test(e.message));
  assert.ok(withExpiry.calls.includes("delete"));

  const noExpiry = memoryApi({ failCreate: true });
  await assert.rejects(createPublicShareFlow(noExpiry.api, "f1", cfg, null), (e: any) => e.stillShared === true && /A link exists/.test(e.message));
  assert.ok(!noExpiry.calls.includes("delete"), "without an expiry request the link is reported, not silently deleted");

  const nothing = memoryApi({ failCreate: true, failReadAfterCreate: true });
  await assert.rejects(createPublicShareFlow(nothing.api, "f1", cfg, null), (e: any) => e.stillShared === false && /No link was found/.test(e.message));
});

test("private flow wraps a failed send as uncertain", async () => {
  const m = memoryApi();
  const out = await createPrivateShareFlow(m.api, "f1", cfg, ["a@b.co"]);
  assert.deepEqual((out.share as any).recipients[0], { recipientId: "r0", contact: "a@b.co", status: null });
  const bad = { ...m.api, createPrivate: async () => { throw new Error("502"); } };
  await assert.rejects(createPrivateShareFlow(bad, "f1", cfg, ["a@b.co"]), (e: any) => e instanceof ShareUncertainError && /emails may already have been sent/.test(e.message));
});
