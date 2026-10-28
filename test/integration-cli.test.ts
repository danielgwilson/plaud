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
      "  fs.appendFileSync(process.env.FAKE_PLAUD_LOG, JSON.stringify({ method, url: String(url), body }) + \"\\n\");",
      '  const json = method === "PATCH" ? { status: 0 } : { status: 0, data_file_list: [detail] };',
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
    .map((line) => JSON.parse(line) as { method: string; url: string; body: any });
  return { ...r, requests, writes: requests.filter((q) => q.method === "PATCH") };
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
