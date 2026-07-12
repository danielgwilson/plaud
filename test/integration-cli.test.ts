import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

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
