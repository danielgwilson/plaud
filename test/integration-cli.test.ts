import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plaud-cli-it-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const cliPath = path.resolve(process.cwd(), "dist/cli.js");
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (d) => stdout.push(d));
  child.stderr.on("data", (d) => stderr.push(d));

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });

  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8").trim(),
    stderr: Buffer.concat(stderr).toString("utf8").trim(),
  };
}

test("auth show --json returns v1 envelope on missing auth (exit 2)", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["auth", "show", "--json"], {
      XDG_CONFIG_HOME: tmp,
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTH_MISSING");
  });
});

test("files list --json returns v1 envelope on missing auth (exit 2)", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "list", "--json", "--limit", "1"], {
      XDG_CONFIG_HOME: tmp,
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTH_MISSING");
  });
});

test("doctor --json returns v1 envelope on missing auth (exit 2)", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["doctor", "--json"], {
      XDG_CONFIG_HOME: tmp,
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTH_MISSING");
    assert.ok(parsed.meta?.checks?.some?.((c: any) => c?.name === "token.present"));
  });
});

test("files trash returns v1 envelope on missing auth (exit 2)", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "trash", "deadbeefdeadbeefdeadbeefdeadbeef"], {
      XDG_CONFIG_HOME: tmp,
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTH_MISSING");
  });
});

test("files speakers list --json returns v1 envelope on missing auth (exit 2)", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "speakers", "list", "deadbeefdeadbeefdeadbeefdeadbeef", "--json"], {
      XDG_CONFIG_HOME: tmp,
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTH_MISSING");
  });
});

test("files speakers --help lists apply", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "speakers", "--help"], { XDG_CONFIG_HOME: tmp, PLAUD_AUTH_TOKEN: "" });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /^\s+apply\b/m);
    const apply = await runCli(["files", "speakers", "apply", "--help"], { XDG_CONFIG_HOME: tmp, PLAUD_AUTH_TOKEN: "" });
    assert.equal(apply.exitCode, 0);
    for (const flag of ["--map", "--segments", "--overwrite", "--expect-version", "--no-summary", "--dry-run"]) {
      assert.ok(apply.stdout.includes(flag), `help should mention ${flag}`);
    }
  });
});

test("files speakers apply returns v1 envelope on missing auth (exit 2)", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "speakers", "apply", "deadbeefdeadbeefdeadbeefdeadbeef", "--map", '{"Speaker 1":"Person A"}'], {
      XDG_CONFIG_HOME: tmp,
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTH_MISSING");
  });
});

test("files speakers apply validates its inputs before touching auth or the network", async () => {
  await withTempDir(async (tmp) => {
    const missingFile = path.join(tmp, "nope.json");
    const cases: Array<{ args: string[]; message: RegExp }> = [
      { args: [], message: /Provide --map, --segments, and\/or --summary-map/ },
      { args: ["--summary-map", "[]"], message: /--summary-map must be a JSON object/ },
      { args: ["--summary-map", '{"Pat Lee":""}'], message: /must not be empty/ },
      { args: ["--summary-map", '{"Pat Lee":"Speaker 2"}', "--no-summary"], message: /cannot be combined with --no-summary/ },
      { args: ["--map", "{not json"], message: /--map must be valid JSON/ },
      { args: ["--map", "[]"], message: /--map must be a JSON object/ },
      { args: ["--map", "{}"], message: /at least one --map entry/ },
      { args: ["--map", '{"Speaker 1":""}'], message: /must not be empty/ },
      { args: ["--map", '{"Speaker 1":7}'], message: /must be a string/ },
      { args: ["--map", `@${missingFile}`], message: /cannot read file/ },
      { args: ["--segments", "{}"], message: /--segments must be a JSON array/ },
      { args: ["--segments", '[{"speaker":"Person A"}]'], message: /needs segment_uid, or numeric start_time and end_time/ },
      {
        args: ["--segments", '[{"segment_uid":"u1","speaker":"Person A"},{"segment_uid":"u1","speaker":"Person B"}]'],
        message: /conflicting names/,
      },
      { args: ["--map", '{"Speaker 1":"Person A"}', "--expect-version", "abc"], message: /--expect-version must be/ },
    ];
    for (const c of cases) {
      const r = await runCli(["files", "speakers", "apply", "synthetic-id", ...c.args], {
        XDG_CONFIG_HOME: tmp,
        PLAUD_AUTH_TOKEN: "",
      });
      assert.equal(r.exitCode, 2, c.args.join(" "));
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, "VALIDATION");
      assert.match(parsed.error.message, c.message);
    }
  });
});

// Runs the CLI with a synthetic in-process fetch (no network): POST /file/list returns `detail`,
// every request is appended to a log file so tests can assert on the writes.
async function runWithFakePlaud(
  tmp: string,
  detail: unknown,
  args: string[],
  files: Record<string, string> = {},
  command: string[] = ["files", "speakers", "apply", "rec-1"],
) {
  const preload = path.join(tmp, "fake-plaud-fetch.mjs");
  const detailPath = path.join(tmp, "detail.json");
  const logPath = path.join(tmp, "requests.log");
  await fs.writeFile(
    preload,
    [
      'import fs from "node:fs";',
      'const detail = JSON.parse(fs.readFileSync(process.env.FAKE_PLAUD_DETAIL, "utf8"));',
      "globalThis.fetch = async (url, init = {}) => {",
      '  const method = init.method || "GET";',
      "  const body = init.body ? JSON.parse(init.body) : null;",
      "  fs.appendFileSync(process.env.FAKE_PLAUD_LOG, JSON.stringify({ method, url: String(url), body, headers: init.headers || {} }) + \"\\n\");",
      '  let json = method === "PATCH" ? { status: 0 } : { status: 0, data_file_list: [detail] };',
      '  if (detail.__fail && (method + " " + new URL(String(url)).pathname).startsWith(detail.__fail)) { return { ok: false, status: 500, statusText: "boom", json: async () => ({ detail: "boom" }) }; }',
      '  const hasDeleted = fs.readFileSync(process.env.FAKE_PLAUD_LOG, "utf8").includes(\'"method":"DELETE"\');',
      '  if (String(url).endsWith("/filetag/") && method === "GET") json = { status: 0, data_filetag_list: detail.__goneAfterDelete && hasDeleted ? [] : detail.__tags || [] };',
      '  else if (String(url).endsWith("/filetag/") && method === "POST") json = detail.__dup ? { status: -2, msg: "exists" } : { status: 0, data_filetag: { id: "new-tag", ...body } };',
      '  else if (String(url).includes("/filetag/")) json = detail.__dup ? { status: -2 } : { status: 0 };',
      '  else if (String(url).includes("/file/simple/web") && detail.__files) json = { status: 0, data_file_list: detail.__files };',
      '  else if (String(url).includes("/user/stat/file")) json = { status: 0, data_stat: detail.__stat };',
      '  else if (String(url).includes("/user/stat/transcription/quota")) json = detail.__quota;',
      '  else if (String(url).includes("/file/list") && detail.__lookupStatus) json = { status: detail.__lookupStatus, msg: "lookup failed" };',
      '  else if (String(url).includes("/file/list") && detail.__details) json = { status: 0, data_file_list: detail.__details.filter((d) => (body || []).includes(d.id) && !(detail.__deleteWorks && hasDeleted)) };',
      '  else if (method === "DELETE" && String(url).endsWith("/file/")) json = { status: 0 };',
      '  else if (String(url).endsWith("/ai/query_note")) json = { status: 0, data: detail.__notes || [] };',
      '  else if (String(url).includes("/ai/update_note_info") || String(url).includes("/ai/del_note_info")) json = { status: 0 };',
      '  return { ok: true, status: 200, statusText: "OK", json: async () => json };',
      "};",
      "",
    ].join("\n"),
  );
  await fs.writeFile(detailPath, JSON.stringify(detail));
  await fs.writeFile(logPath, "");
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(tmp, name), content);
  const r = await runCli([...command, ...args], {
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    PLAUD_AUTH_TOKEN: "synthetic-test-token",
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    FAKE_PLAUD_DETAIL: detailPath,
    FAKE_PLAUD_LOG: logPath,
  });
  const requests = (await fs.readFile(logPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; url: string; body: any; headers: Record<string, string> });
  return { ...r, requests, writes: requests.filter((q) => q.method === "PATCH"), posts: requests.filter((q) => q.method === "POST") };
}

function syntheticRecording(speakers: [string, string][] = [["Speaker 1", "Speaker 1"], ["Speaker 2", "Speaker 2"], ["Speaker 1", "Speaker 1"]]) {
  return {
    id: "rec-1",
    version: 7,
    ai_content: "Speaker 1 opened and Speaker 10 left. Speaker 2 agreed.",
    trans_result: speakers.map(([speaker, original], i) => ({
      start_time: i * 1000,
      end_time: (i + 1) * 1000,
      content: `line ${i}`,
      speaker,
      original_speaker: original,
    })),
  };
}

test("files speakers apply writes the whole mapping in one PATCH", async () => {
  await withTempDir(async (tmp) => {
    const r = await runWithFakePlaud(tmp, syntheticRecording(), [
      "--map",
      '{"Speaker 1":"Ada Lovelace","Speaker 2":"Alan Turing"}',
    ]);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.action, "files.speakers.apply");
    assert.equal(parsed.data.dryRun, false);
    assert.equal(parsed.data.written, true);
    assert.equal(parsed.data.versionRead, 7);
    assert.equal(parsed.data.changed, 3);
    assert.equal(parsed.data.skippedRenamed, 0);
    assert.equal(parsed.data.summaryReplacements, 2);
    assert.deepEqual(parsed.data.unmatchedLabels, []);
    assert.deepEqual(parsed.data.response, { status: 0 });

    assert.equal(r.requests.length, 2, "one read, one write");
    assert.equal(r.writes.length, 1);
    assert.match(r.writes[0].url, /\/file\/rec-1$/);
    assert.equal(r.writes[0].body.support_mul_summ, true);
    assert.deepEqual(
      r.writes[0].body.trans_result.map((s: any) => s.speaker),
      ["Ada Lovelace", "Alan Turing", "Ada Lovelace"],
    );
    assert.equal(r.writes[0].body.ai_content, "Ada Lovelace opened and Speaker 10 left. Alan Turing agreed.");
  });
});

test("files speakers apply reads --map from @file and --no-summary leaves ai_content out", async () => {
  await withTempDir(async (tmp) => {
    const r = await runWithFakePlaud(
      tmp,
      syntheticRecording(),
      ["--map", `@${path.join(tmp, "map.json")}`, "--no-summary"],
      { "map.json": '{"Speaker 2":"Alan Turing"}' },
    );
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.data.changed, 1);
    assert.equal(parsed.data.summaryReplacements, 0);
    assert.equal(r.writes.length, 1);
    assert.equal("ai_content" in r.writes[0].body, false);
  });
});

test("files speakers apply --summary-map alone writes only ai_content", async () => {
  await withTempDir(async (tmp) => {
    const detail = { ...syntheticRecording(), ai_content: "Pat Lee opened. Pat agreed. Patrick left." };
    const r = await runWithFakePlaud(tmp, detail, ["--summary-map", '{"Pat Lee":"Speaker 2","Pat":"Speaker 2"}']);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.data.changed, 0);
    assert.equal(parsed.data.summaryReplacements, 2);
    assert.equal(parsed.data.written, true);
    assert.equal(r.writes.length, 1);
    assert.equal("trans_result" in r.writes[0].body, false);
    assert.equal(r.writes[0].body.ai_content, "Speaker 2 opened. Speaker 2 agreed. Patrick left.");
  });
});

test("files speakers apply --dry-run reports the plan without writing", async () => {
  await withTempDir(async (tmp) => {
    const r = await runWithFakePlaud(tmp, syntheticRecording(), ["--map", '{"Speaker 1":"Ada Lovelace"}', "--dry-run"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.data.dryRun, true);
    assert.equal(parsed.data.written, false);
    assert.equal(parsed.data.changed, 2);
    assert.equal(parsed.data.summaryReplacements, 1);
    assert.equal(r.writes.length, 0);
  });
});

test("files speakers apply --expect-version fails with CONFLICT before writing", async () => {
  await withTempDir(async (tmp) => {
    const r = await runWithFakePlaud(tmp, syntheticRecording(), [
      "--map",
      '{"Speaker 1":"Ada Lovelace"}',
      "--expect-version",
      "6",
    ]);
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "CONFLICT");
    assert.equal(parsed.meta.versionRead, 7);
    assert.equal(r.writes.length, 0);

    const match = await runWithFakePlaud(tmp, syntheticRecording(), [
      "--map",
      '{"Speaker 1":"Ada Lovelace"}',
      "--expect-version",
      "7",
    ]);
    assert.equal(match.exitCode, 0, match.stderr);
    assert.equal(match.writes.length, 1);
  });
});

test("files speakers apply is a clean no-op when the names are already applied", async () => {
  await withTempDir(async (tmp) => {
    const done = syntheticRecording([["Ada Lovelace", "Speaker 1"], ["Alan Turing", "Speaker 2"], ["Ada Lovelace", "Speaker 1"]]);
    done.ai_content = "Ada Lovelace opened and Speaker 10 left. Alan Turing agreed.";
    const r = await runWithFakePlaud(tmp, done, ["--map", '{"Speaker 1":"Ada Lovelace","Speaker 2":"Alan Turing"}']);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.changed, 0);
    assert.equal(parsed.data.alreadyApplied, 3);
    assert.equal(parsed.data.summaryReplacements, 0);
    assert.equal(parsed.data.written, false);
    assert.equal(r.writes.length, 0);
  });
});

test("files speakers apply guard reports names a human already typed", async () => {
  await withTempDir(async (tmp) => {
    const typed = syntheticRecording([["Ada (typed)", "Speaker 1"], ["Speaker 2", "Speaker 2"], ["Speaker 1", "Speaker 1"]]);
    const r = await runWithFakePlaud(tmp, typed, ["--map", '{"Speaker 1":"Ada Lovelace","Speaker 7":"Nobody"}']);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.data.changed, 1);
    assert.equal(parsed.data.skippedRenamed, 1);
    assert.deepEqual(parsed.data.unmatchedLabels, ["Speaker 7"]);
    assert.equal(parsed.data.summaryReplacements, 0);
    assert.equal(r.writes.length, 1);
    assert.deepEqual(
      r.writes[0].body.trans_result.map((s: any) => s.speaker),
      ["Ada (typed)", "Speaker 2", "Ada Lovelace"],
    );
  });
});

test("files link prints the web app link without auth", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "link", "rec-1", "--json"], { XDG_CONFIG_HOME: tmp, PLAUD_AUTH_TOKEN: "" });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).data, { id: "rec-1", url: "https://web.plaud.ai/file/rec-1" });
    const plain = await runCli(["files", "link", "rec-1"], { XDG_CONFIG_HOME: tmp, PLAUD_AUTH_TOKEN: "" });
    assert.equal(plain.stdout, "https://web.plaud.ai/file/rec-1");
  });
});

test("files get and files list carry the web app link", async () => {
  await withTempDir(async (tmp) => {
    const detail = { ...syntheticRecording(), filename: "Weekly sync", start_time: 1_700_000_000_000 };
    const got = await runWithFakePlaud(tmp, detail, ["--json"], {}, ["files", "get", "rec-1"]);
    assert.equal(got.exitCode, 0, got.stderr);
    assert.equal(JSON.parse(got.stdout).data.url, "https://web.plaud.ai/file/rec-1");
    const listed = await runWithFakePlaud(tmp, detail, ["--json", "--limit", "1"], {}, ["files", "list"]);
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).data.items[0].url, "https://web.plaud.ai/file/rec-1");
  });
});

test("files upload --json returns v1 envelope on missing auth (exit 2)", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "upload", "nope.mp3", "--json"], { XDG_CONFIG_HOME: tmp, PLAUD_AUTH_TOKEN: "" });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTH_MISSING");
  });
});

test("files upload --json reports a missing file before any network call", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "upload", path.join(tmp, "nope.mp3"), "--json"], { XDG_CONFIG_HOME: tmp, PLAUD_AUTH_TOKEN: "x" });
    assert.equal(r.exitCode, 1);
    assert.equal(JSON.parse(r.stdout).error.code, "FILE_NOT_FOUND");
  });
});

test("files rename sends the web app's title edit body", async () => {
  await withTempDir(async (tmp) => {
    const r = await runWithFakePlaud(tmp, syntheticRecording(), ["rec-1", "Board review"], {}, ["files", "rename"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.writes.length, 1);
    assert.match(r.writes[0].url, /\/file\/rec-1$/);
    assert.deepEqual(r.writes[0].body, { filename: "Board review", extra_data: { actionData: { hasTitleEdit: true } } });
    assert.equal(JSON.parse(r.stdout).data.url, "https://web.plaud.ai/file/rec-1");
    const empty = await runWithFakePlaud(tmp, syntheticRecording(), ["rec-1", "  "], {}, ["files", "rename"]);
    assert.equal(empty.exitCode, 2);
    assert.equal(empty.writes.length, 0);
  });
});

test("files transcript edit and replace write the expected body, guard versions, and validate input", async () => {
  await withTempDir(async (tmp) => {
    const detail = { ...syntheticRecording(), trans_result: [{ content: "alpha beta", speaker: "Speaker 1" }, { content: "second", speaker: "Speaker 2" }] };
    const run = (args: string[], cmd: string[]) => runWithFakePlaud(tmp, detail, args, {}, ["files", "transcript", cmd[0]]);

    const edit = await run(["rec-1", "--segment", "1", "--text", "changed"], ["edit"]);
    assert.equal(edit.exitCode, 0, edit.stderr);
    assert.equal(edit.writes.length, 1);
    assert.deepEqual(edit.writes[0].body.trans_result.map((x: any) => x.content), ["alpha beta", "changed"]);
    assert.equal(edit.writes[0].body.trans_result[1].speaker, "Speaker 2");
    assert.equal(JSON.parse(edit.stdout).data.versionRead, 7);

    const guarded = await run(["rec-1", "--segment", "1", "--text", "x", "--expect-text", "stale"], ["edit"]);
    assert.equal(guarded.exitCode, 2);
    assert.equal(guarded.writes.length, 0);

    const wrongVersion = await run(["rec-1", "--segment", "0", "--text", "x", "--expect-version", "99"], ["edit"]);
    assert.equal(wrongVersion.exitCode, 2);
    assert.match(JSON.parse(wrongVersion.stdout).error.message, /version is 7, expected 99/);
    assert.equal(wrongVersion.writes.length, 0);

    for (const seg of ["", "1e1", "0x1", "-1", "abc"]) {
      const bad = await run(["rec-1", "--segment", seg, "--text", "x"], ["edit"]);
      assert.equal(bad.exitCode, 2, `segment ${JSON.stringify(seg)}`);
      assert.equal(bad.writes.length, 0);
    }

    const dry = await run(["rec-1", "--find", "beta", "--with", "gamma", "--dry-run"], ["replace"]);
    assert.equal(dry.writes.length, 0, "dry run writes nothing");
    assert.equal(JSON.parse(dry.stdout).data.changed, 1);

    const real = await run(["rec-1", "--find", "beta", "--with", "gamma"], ["replace"]);
    assert.equal(real.writes.length, 1);
    assert.equal(real.writes[0].body.trans_result[0].content, "alpha gamma");
    assert.equal(real.writes[0].body.support_mul_summ, true);

    const noop = await run(["rec-1", "--find", "beta", "--with", "beta"], ["replace"]);
    assert.equal(noop.writes.length, 0, "identical replacement is not a write");
  });
});

test("files notes list sends the file-id header; set and delete post the expected bodies", async () => {
  await withTempDir(async (tmp) => {
    const notes = [
      { data_id: "sum-1", data_type: "auto_sum_note", data_title: "Summary", data_content: "old summary" },
      { data_id: "note-2", data_type: "mark_note", data_title: "My note", data_content: "old text" },
    ];
    const detail = { ...syntheticRecording(), __notes: notes };
    const run = (args: string[], sub: string) => runWithFakePlaud(tmp, detail, args, {}, ["files", "notes", sub]);

    const listed = await run(["rec-1"], "list");
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).data.count, 2);
    const q = listed.requests.find((x) => x.url.endsWith("/ai/query_note"));
    assert.equal(q?.headers["file-id"], "rec-1");

    const set = await run(["rec-1", "note-2", "--title", "Renamed", "--content", "new text"], "set");
    assert.equal(set.exitCode, 0, set.stderr);
    const upd = set.posts.find((x) => x.url.endsWith("/ai/update_note_info"));
    assert.deepEqual(upd?.body, { file_id: "rec-1", note_id: "note-2", note_type: "mark_note", note_title: "Renamed", note_content: "new text" });
    assert.deepEqual(JSON.parse(set.stdout).data.before, { title: "My note", content: "old text" });

    const dry = await run(["rec-1", "note-2", "--content", "x", "--dry-run"], "set");
    assert.equal(dry.posts.filter((x) => x.url.endsWith("/ai/update_note_info")).length, 0);

    const summaryTitle = await run(["rec-1", "sum-1", "--title", "Nope"], "set");
    assert.equal(summaryTitle.exitCode, 2);
    const missingFile = await run(["rec-1", "note-2", "--file", path.join(tmp, "missing.md")], "set");
    assert.equal(missingFile.exitCode, 2);

    const del = await run(["rec-1", "note-2"], "delete");
    assert.equal(del.exitCode, 0, del.stderr);
    assert.deepEqual(del.posts.find((x) => x.url.endsWith("/ai/del_note_info"))?.body, { note_id: "note-2", note_type: "mark_note", note_content: "old text" });
    assert.equal(JSON.parse(del.stdout).data.deleted.title, "My note");

    const delSummary = await run(["rec-1", "sum-1"], "delete");
    assert.equal(delSummary.exitCode, 2);
    assert.equal(delSummary.posts.filter((x) => x.url.endsWith("/ai/del_note_info")).length, 0);
  });
});

test("files tags create, rename and delete send the expected bodies and guard deletion", async () => {
  await withTempDir(async (tmp) => {
    const tags = [
      { id: "t1", name: "Interviews", icon: "e675", color: "#c149eb" },
      { id: "t2", name: "Interviews", icon: "e675", color: "#c149eb" },
      { id: "t3", name: "Board", icon: "e64a", color: "#ffaa5c" },
    ];
    const detail = { ...syntheticRecording(), __tags: tags };
    const run = (sub: string, args: string[], d: any = detail) => runWithFakePlaud(tmp, d, args, {}, ["files", "tags", sub]);

    const created = await run("create", ["Hiring", "--color", "#ABCDEF"]);
    assert.equal(created.exitCode, 0, created.stderr);
    const post = created.requests.find((x) => x.method === "POST" && x.url.endsWith("/filetag/"));
    assert.deepEqual(post?.body, { name: "Hiring", icon: "e674", color: "#abcdef" });
    assert.equal(JSON.parse(created.stdout).data.tag.id, "new-tag");

    const dup = await run("create", ["Hiring"], { ...detail, __dup: true });
    assert.equal(JSON.parse(dup.stdout).error.code, "DUPLICATE");
    assert.equal(dup.exitCode, 1);
    const dupRename = await run("rename", ["Board", "--name", "Interviews2"], { ...detail, __dup: true });
    assert.equal(JSON.parse(dupRename.stdout).error.code, "DUPLICATE");

    const flaky = await run("create", ["Hiring"], { ...detail, __fail: "POST /filetag/" });
    assert.equal(flaky.exitCode, 1);
    assert.equal(flaky.requests.filter((x) => x.method === "POST").length, 1, "create is never retried");

    const lostReply = await run("delete", ["Board", "--yes"], { ...detail, __fail: "DELETE /filetag/", __goneAfterDelete: true });
    assert.equal(lostReply.exitCode, 0, lostReply.stderr);
    assert.equal(lostReply.requests.filter((x) => x.method === "DELETE").length, 1);
    const stillThere = await run("delete", ["Board", "--yes"], { ...detail, __fail: "DELETE /filetag/" });
    assert.equal(stillThere.exitCode, 1);

    assert.equal((await run("create", ["x", "--color", "red"])).exitCode, 2);
    assert.equal((await run("create", ["  "])).exitCode, 2);

    const renamed = await run("rename", ["Board", "--name", "Board 2026"]);
    assert.equal(renamed.exitCode, 0, renamed.stderr);
    const patch = renamed.requests.find((x) => x.method === "PATCH");
    assert.match(patch!.url, /\/filetag\/t3$/);
    assert.deepEqual(patch!.body, { name: "Board 2026", icon: "e64a", color: "#ffaa5c" });

    const ambiguous = await run("rename", ["interviews", "--name", "x"]);
    assert.equal(ambiguous.exitCode, 2);
    assert.match(JSON.parse(ambiguous.stdout).error.message, /More than one folder/);
    assert.equal(ambiguous.requests.filter((x) => x.method === "PATCH").length, 0);
    assert.equal((await run("rename", ["Board"])).exitCode, 2, "nothing to change");

    const withFiles = { ...detail, __files: [{ id: "f1", filename: "Board call", filetag_id_list: ["t3"] }, { id: "f2", filename: "Other", filetag_id_list: ["t1"] }] };
    const noYes = await run("delete", ["Board"], withFiles);
    assert.equal(noYes.exitCode, 2);
    assert.match(JSON.parse(noYes.stdout).error.message, /1 file\(s\) to the trash: "Board call"/);
    assert.equal(noYes.requests.filter((x) => x.method === "DELETE").length, 0);
    const yes = await run("delete", ["t3", "--yes"], withFiles);
    assert.equal(yes.exitCode, 0, yes.stderr);
    assert.deepEqual(JSON.parse(yes.stdout).data.trashedFileIds, ["f1"]);
    assert.equal(yes.requests.filter((x) => x.method === "DELETE").length, 1, "delete is sent once");
    const del = yes.requests.find((x) => x.method === "DELETE");
    assert.match(del!.url, /\/filetag\/t3$/);
    assert.equal(JSON.parse(yes.stdout).data.deleted.name, "Board");
  });
});

test("account stats and quota normalize the API and never POST", async () => {
  await withTempDir(async (tmp) => {
    const detail = {
      ...syntheticRecording(),
      __stat: {
        total_files: 3, total_days: 2, total_duration: 7_200_000, total_transcribed_duration: 3_600_000,
        recent_30_days_daily_avg: 1800, previous_30_days_daily_avg: 900, most_active_hour: 21, max_files: 2, max_duration: 5_000_000,
        group_result: [{ day: "2026-11-01", count: 2, duration: 5_000_000 }, { day: "2026-11-02", count: 1, duration: 2_200_000 }],
      },
      __quota: { is_starter: true, can_notify: true, quota: { files: 5 } },
    };
    const stats = await runWithFakePlaud(tmp, detail, ["--json"], {}, ["account", "stats"]);
    assert.equal(stats.exitCode, 0, stats.stderr);
    const d = JSON.parse(stats.stdout).data;
    assert.equal(d.totalFiles, 3);
    assert.equal(d.recent30DaysDailyAvgMs, 1_800_000, "seconds per day become milliseconds");
    assert.equal(d.daily, undefined, "per-day rows only with --daily");
    const daily = await runWithFakePlaud(tmp, detail, ["--json", "--daily"], {}, ["account", "stats"]);
    assert.deepEqual(JSON.parse(daily.stdout).data.daily[0], { day: "2026-11-01", files: 2, durationMs: 5_000_000 });
    const plain = await runWithFakePlaud(tmp, detail, [], {}, ["account", "stats"]);
    assert.match(plain.stdout, /3 files over 2 active days, 2\.0 h recorded/);

    const quota = await runWithFakePlaud(tmp, detail, ["--json"], {}, ["account", "quota"]);
    assert.deepEqual(JSON.parse(quota.stdout).data, { isStarter: true, canNotify: true, quota: { files: 5 } });
    assert.match(quota.requests[0].url, /quota\?notification=tag$/);
    assert.equal(quota.requests.filter((x) => x.method !== "GET").length, 0);

    const paid = await runWithFakePlaud(tmp, { ...detail, __quota: { is_starter: false } }, ["--json"], {}, ["account", "quota"]);
    assert.deepEqual(JSON.parse(paid.stdout).data, { isStarter: false, canNotify: null, quota: null });

    const bad = await runWithFakePlaud(tmp, { ...detail, __stat: undefined }, ["--json"], {}, ["account", "stats"]);
    assert.equal(bad.exitCode, 1);
    assert.equal(JSON.parse(bad.stdout).ok, false);
    const badQuota = await runWithFakePlaud(tmp, { ...detail, __quota: { status: -1, msg: "Invalid notification type" } }, ["--json"], {}, ["account", "quota"]);
    assert.equal(badQuota.exitCode, 1);
    assert.match(JSON.parse(badQuota.stdout).error.message, /Invalid notification/);
  });
});

test("files delete only removes files already in the trash, after --yes, in one request", async () => {
  await withTempDir(async (tmp) => {
    const details = [
      { id: "t1", filename: "Trashed one", is_trash: true },
      { id: "t2", filename: "Trashed two", is_trash: true },
      { id: "a1", filename: "Active", is_trash: false },
    ];
    const base = { ...syntheticRecording(), __details: details, __deleteWorks: true };
    const run = (args: string[], d: any = base) => runWithFakePlaud(tmp, d, args, {}, ["files", "delete"]);
    const deletes = (r: { requests: Array<{ method: string }> }) => r.requests.filter((x) => x.method === "DELETE");

    const noYes = await run(["t1"]);
    assert.equal(noYes.exitCode, 2);
    assert.match(JSON.parse(noYes.stdout).error.message, /cannot be undone/);
    assert.equal(deletes(noYes).length, 0);

    const active = await run(["t1", "a1", "--yes"]);
    assert.equal(active.exitCode, 2);
    assert.match(JSON.parse(active.stdout).error.message, /a1 \("Active"\) is not in the trash.*nothing was deleted/);
    assert.equal(deletes(active).length, 0, "one active file blocks the whole batch");

    const missing = await run(["t1", "nope", "--yes"]);
    assert.equal(missing.exitCode, 2);
    assert.equal(deletes(missing).length, 0);

    const real = await run(["t1", "t2", "t1", "--yes"]);
    assert.equal(real.exitCode, 0, real.stderr);
    assert.equal(deletes(real).length, 1);
    const del = real.requests.find((x) => x.method === "DELETE")!;
    assert.match(del.url, /\/file\/$/);
    assert.deepEqual(del.body, ["t1", "t2"], "ids are de-duplicated and sent once");
    const out = JSON.parse(real.stdout).data;
    assert.deepEqual(out.deletedIds, ["t1", "t2"]);
    assert.deepEqual(out.stillPresentIds, []);

    const ignored = await run(["t1", "--yes"], { ...base, __deleteWorks: false });
    assert.equal(ignored.exitCode, 1, "files still present after the delete is a failure, not exit 0");
    const ignoredOut = JSON.parse(ignored.stdout);
    assert.equal(ignoredOut.ok, false);
    assert.equal(ignoredOut.error.code, "DELETE_INCOMPLETE");
    assert.deepEqual(ignoredOut.meta.stillPresentIds, ["t1"]);

    const oddId = await run(["t1 ", "--yes"]);
    assert.equal(oddId.exitCode, 2);
    assert.equal(deletes(oddId).length, 0);

    const lostReply = await run(["t1", "--yes"], { ...base, __deleteWorks: true, __fail: "DELETE /file/" });
    assert.equal(lostReply.exitCode, 0, "a failed reply for a delete that went through still settles as deleted");
    assert.deepEqual(JSON.parse(lostReply.stdout).data.deletedIds, ["t1"]);

    const badLookup = await run(["t1", "--yes"], { ...base, __lookupStatus: -1 });
    assert.equal(badLookup.exitCode, 1);
    assert.equal(deletes(badLookup).length, 0, "an error reply from the lookup never reads as 'no such file'");
  });
});

test("store status --json works without auth", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["store", "status", "--json"], {
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      PLAUD_STORE_DIR: path.join(tmp, "store"),
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.recordings, 0);
    assert.equal(parsed.data.snapshots, 0);
  });
});

test("files search --ids-only returns coverage warnings", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "search", "--all", "--ids-only", "--json"], {
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      PLAUD_STORE_DIR: path.join(tmp, "store"),
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.coverage.exhaustive, false);
    assert.deepEqual(parsed.data.coverage.fieldsSearched, []);
    assert.equal(parsed.data.coverage.riskFactors.truncated, false);
    assert.ok(parsed.meta.coverageWarnings.some((warning: string) => /not proof of exhaustive corpus coverage/.test(warning)));
  });
});

test("files search requires a query or --all", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "search", "--json"], {
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      PLAUD_STORE_DIR: path.join(tmp, "store"),
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "VALIDATION");
  });
});

test("files search validates date filters", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "search", "--all", "--from", "bad-date", "--json"], {
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      PLAUD_STORE_DIR: path.join(tmp, "store"),
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "VALIDATION");
    assert.match(parsed.error.message, /Invalid --from date/);
  });
});

test("files dupes validates --by", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "dupes", "--by", "bogus", "--json"], {
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      PLAUD_STORE_DIR: path.join(tmp, "store"),
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "VALIDATION");
    assert.match(parsed.error.message, /Invalid --by value/);
  });
});

test("store clear refuses dangerous paths", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["store", "clear", "--store", "/", "--yes", "--json"], {
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      PLAUD_STORE_DIR: path.join(tmp, "store"),
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "VALIDATION");
    assert.match(parsed.error.message, /Refusing to clear filesystem root/);
  });
});

test("store clear refuses custom directories without a store index", async () => {
  await withTempDir(async (tmp) => {
    const custom = path.join(tmp, "custom");
    await fs.mkdir(custom, { recursive: true });
    const r = await runCli(["store", "clear", "--store", custom, "--yes", "--json"], {
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      PLAUD_STORE_DIR: path.join(tmp, "store"),
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "VALIDATION");
    assert.match(parsed.error.message, /without a Plaud store index/);
  });
});

test("files sync returns v1 envelope on missing auth (exit 2)", async () => {
  await withTempDir(async (tmp) => {
    const r = await runCli(["files", "sync", "--max", "1", "--json"], {
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      PLAUD_STORE_DIR: path.join(tmp, "store"),
      PLAUD_AUTH_TOKEN: "",
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTH_MISSING");
  });
});
