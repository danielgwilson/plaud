#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { Command } from "commander";
import { clearConfig, readConfig, redactToken } from "./config.js";
import { exportRecordings } from "./export.js";
import { downloadRecording } from "./download.js";
import { resolveAuthToken, resolveRegion } from "./plaud-api.js";
import { fail, makeError, ok, printJson } from "./output.js";
import { captureTokenFromBrowser, importTokenFromHar, saveToken, validateToken } from "./auth.js";

function getCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function requireToken({ json }: { json?: boolean }): Promise<string> {
  const token = await resolveAuthToken();
  if (token) return token;
  const err = makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." });
  if (json) printJson(fail(err));
  else {
    // eslint-disable-next-line no-console
    console.error("No auth token. Use `plaud auth login`, `plaud auth set --stdin`, or export `PLAUD_AUTH_TOKEN`.");
  }
  process.exitCode = 2;
  return "";
}

function pickUserLabel(me: any): string {
  if (!me || typeof me !== "object") return "";
  const candidates = [
    me?.user?.email,
    me?.user?.nickname,
    me?.user?.id,
    me.email,
    me.username,
    me.name,
    me.id,
  ].filter(Boolean);
  return candidates.length ? String(candidates[0]) : "";
}

function splitCsv(value: unknown): string[] {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function defaultOutDir(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(process.cwd(), `plaud-transcripts-${date}`);
}

function defaultZipPath(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(process.cwd(), `plaud-transcripts-${date}.zip`);
}

function defaultDownloadDir(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(process.cwd(), `plaud-download-${date}`);
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.round(elapsedMs / 100) / 10;
  return `${seconds.toFixed(1)}s`;
}

function createStatusRenderer() {
  const startedAt = Date.now();
  const spinnerFrames = ["|", "/", "-", "\\"] as const;
  let frame = 0;
  let lastLineLen = 0;
  let lastMsg = "";
  let currentMsg = "";
  let interval: NodeJS.Timeout | null = null;

  const render = () => {
    const elapsedMs = Date.now() - startedAt;
    const spin = spinnerFrames[frame % spinnerFrames.length];
    frame++;
    const msg = currentMsg || lastMsg || "Working";
    const line = `[plaud] ${spin} ${msg} (${formatElapsed(elapsedMs)})`;
    if (line === lastMsg) return;
    lastMsg = line;
    const pad = lastLineLen > line.length ? " ".repeat(lastLineLen - line.length) : "";
    lastLineLen = line.length;
    process.stderr.write(`\r${line}${pad}`);
  };

  return {
    update({ msg, elapsedMs }: { msg: string; elapsedMs?: number }) {
      currentMsg = msg || currentMsg;
      if (!interval) {
        if (typeof elapsedMs === "number") {
          const line = `[plaud] ${msg} (${formatElapsed(elapsedMs)})`;
          if (line !== lastMsg) {
            lastMsg = line;
            const pad = lastLineLen > line.length ? " ".repeat(lastLineLen - line.length) : "";
            lastLineLen = line.length;
            process.stderr.write(`\r${line}${pad}`);
          }
          return;
        }
        render();
      }
    },
    start(msg: string) {
      currentMsg = msg || currentMsg;
      if (interval) return;
      render();
      interval = setInterval(render, 120);
    },
    done(finalMsg?: string) {
      if (interval) clearInterval(interval);
      interval = null;
      if (finalMsg) process.stderr.write(`\r[plaud] ${finalMsg}\n`);
      else process.stderr.write("\n");
    },
  };
}

const program = new Command();
program.name("plaud").description("Export Plaud recordings and transcripts").version(getCliVersion());

program
  .command("auth")
  .description("Manage Plaud auth token")
  .addCommand(
    new Command("show")
      .description("Show token source (redacted)")
      .option("--json", "Print JSON")
      .action(async (opts: { json?: boolean }) => {
        const cfg = await readConfig();
        const env = process.env.PLAUD_AUTH_TOKEN;
        const token = env || cfg?.authToken || "";
        if (!token) {
          if (opts.json) {
            printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No token set" }), { hasToken: false }));
          } else {
            // eslint-disable-next-line no-console
            console.log("No token set. Use `plaud auth login`, `plaud auth set`, or export `PLAUD_AUTH_TOKEN`.");
          }
          process.exitCode = 2;
          return;
        }
        const source = env ? "env:PLAUD_AUTH_TOKEN" : "config";
        const tokenRedacted = redactToken(token);
        if (opts.json) {
          printJson(ok({ hasToken: true, source, tokenRedacted }));
        } else {
          // eslint-disable-next-line no-console
          console.log(`${source}: ${tokenRedacted}`);
        }
      }),
  )
  .addCommand(
    new Command("status")
      .description("Check whether the current token is set and valid")
      .option("--json", "Print JSON")
      .action(async (opts: { json?: boolean }) => {
        const env = process.env.PLAUD_AUTH_TOKEN;
        const cfg = await readConfig();
        const token = await resolveAuthToken();
        const region = await resolveRegion();
        const source = env ? "env:PLAUD_AUTH_TOKEN" : cfg?.authToken ? "config" : null;

        if (!token) {
          if (opts.json) {
            printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No token set" }), { hasToken: false, source }));
          } else {
            // eslint-disable-next-line no-console
            console.log("No token set. Run `plaud auth login`.");
          }
          process.exitCode = 2;
          return;
        }

        const validation = await validateToken(token, region);
        const tokenRedacted = redactToken(token);
        const meLabel = validation.ok ? pickUserLabel(validation.me) : "";

        if (opts.json) {
          printJson(ok({ hasToken: true, source, tokenRedacted, validation }));
        } else if (validation.ok) {
          // eslint-disable-next-line no-console
          console.log(`Logged in${meLabel ? ` as ${meLabel}` : ""} (${source || "unknown source"})`);
        } else {
          // eslint-disable-next-line no-console
          console.log(`Token present but invalid: ${validation.reason}`);
        }

        if (!validation.ok) process.exitCode = 1;
      }),
  )
  .addCommand(
    new Command("login")
      .description("Open a browser, login to Plaud, and capture the auth token")
      .option("--timeout-ms <n>", "Timeout waiting for login (ms)", (v) => Number(v), 180000)
      .option("--url <url>", "Login URL to open", "https://app.plaud.ai")
      .option("--channel <channel>", "Browser channel (chrome or msedge)", "chrome")
      .option("--headless", "Run headless (not recommended for login)", false)
      .option("--force", "Capture even if an existing token is valid", false)
      .option("--region <region>", "API region: us or eu (default: us)", "us")
      .option("--json", "Print JSON")
      .action(async (opts: { timeoutMs: number; url: string; channel: string; headless?: boolean; force?: boolean; region: string; json?: boolean }) => {
        const region = (opts.region === "eu" ? "eu" : "us") as "us" | "eu";
        try {
          const existing = await resolveAuthToken();
          if (existing && !opts.force) {
            const existingValidation = await validateToken(existing, region);
            if (existingValidation.ok) {
              const msg = "Already logged in (existing token is valid). Use --force to recapture.";
              if (opts.json) {
                printJson(ok({ alreadyLoggedIn: true, message: msg, tokenRedacted: redactToken(existing) }));
              } else {
                // eslint-disable-next-line no-console
                console.log(msg);
              }
              return;
	          }
	        }

	        const status = opts.json ? null : createStatusRenderer();
	        status?.start("Waiting for login");
	        const token = await captureTokenFromBrowser({
	          url: opts.url,
	          timeoutMs: Math.max(10_000, Number(opts.timeoutMs || 180000)),
	          channel: opts.channel,
	          headless: !!opts.headless,
	          onStatus: (s) => status?.update(s),
	        });

	        status?.update({ msg: "Saving token" });
	        const saved = await saveToken(token, region);
	        status?.update({ msg: "Validating token" });
	        const validation = await validateToken(saved, region);
	        status?.done(validation.ok ? "Login complete" : "Token saved (validation failed)");

	        if (!validation.ok) process.exitCode = 1;

	        if (opts.json) {
	          printJson(ok({ tokenRedacted: redactToken(saved), validation }));
	          return;
	        }

	        // Keep stdout quiet; print user guidance to stderr.
	        // eslint-disable-next-line no-console
	        console.error(`Saved Plaud token (${redactToken(saved)}) to ~/.config/plaud/config.json (mode 0600).`);
	        // eslint-disable-next-line no-console
	        console.error("Next: `plaud auth status` or `plaud doctor`.");
        } catch (err: any) {
          process.exitCode = 1;
          if (opts.json) {
            printJson(fail(makeError(err)));
            return;
          }
          throw err;
        }
      }),
  )
  .addCommand(
    new Command("set")
      .description("Store token in ~/.config/plaud/config.json")
      .option("--stdin", "Read token from stdin")
      .option("--region <region>", "API region: us or eu (default: us)", "us")
      .option("--json", "Print JSON")
      .action(async (opts: { stdin?: boolean; region: string; json?: boolean }) => {
        const region = (opts.region === "eu" ? "eu" : "us") as "us" | "eu";
	        if (!opts.stdin) {
	          const msg = "Provide the token via stdin: `plaud auth set --stdin` (then paste token and Ctrl-D).";
	          if (opts.json) {
	            printJson(fail(makeError(null, { code: "VALIDATION", message: msg })));
	          } else {
	            // eslint-disable-next-line no-console
	            console.error(msg);
	          }
	          process.exitCode = 2;
	          return;
	        }

	        if (process.stdin.isTTY && !opts.json) {
	          // eslint-disable-next-line no-console
	          console.error("Paste Plaud token, then press Ctrl-D to submit.");
	        }
	        const token = (await readStdin()).trim();

        if (!token || !token.replace(/^bearer\s+/i, "").startsWith("eyJ")) {
          const msg = "Invalid token. Provide the JWT starting with `eyJ`.";
          if (opts.json) {
            printJson(fail(makeError(null, { code: "VALIDATION", message: msg })));
          } else {
            // eslint-disable-next-line no-console
            console.error(msg);
          }
          process.exitCode = 2;
          return;
        }

	        const saved = await saveToken(token, region);
	        if (opts.json) {
	          printJson(ok({ saved: true, tokenRedacted: redactToken(saved) }));
	        } else {
	          // eslint-disable-next-line no-console
	          console.error(`Saved token: ${redactToken(saved)}`);
	        }
	      }),
	  )
  .addCommand(
    new Command("import-har")
      .description("Extract a bearer token from a Plaud HAR file and store it")
      .argument("<path>", "Path to HAR file (may include Authorization headers)")
      .option("--json", "Print JSON")
      .action(async (harPath: string, opts: { json?: boolean }) => {
        try {
          const token = await importTokenFromHar(harPath);
          await saveToken(token);
	          if (opts.json) {
	            printJson(ok({ imported: true, tokenRedacted: redactToken(token) }));
	          } else {
	            // eslint-disable-next-line no-console
	            console.error(`Imported token: ${redactToken(token)}`);
	          }
	        } catch (err: any) {
          const msg = err?.message || String(err);
          const likelyUserIssue =
            msg.includes("No bearer token") || msg.includes("Invalid HAR") || msg.includes("missing log.entries");
          process.exitCode = likelyUserIssue ? 2 : 1;
          if (opts.json) {
            printJson(fail(makeError(err)));
            return;
          }
          throw err;
        }
      }),
  )
  .addCommand(
    new Command("clear")
      .description("Remove stored token")
      .option("--json", "Print JSON")
      .action(async (opts: { json?: boolean }) => {
        await clearConfig();
        if (opts.json) {
          printJson(ok({ cleared: true }));
        } else {
          // eslint-disable-next-line no-console
          console.log("Cleared stored token.");
        }
      }),
  );

const filesCmd = program.command("files").alias("recordings").description("Manage Plaud files");

function normalizeMatchMode(value: unknown): "original" | "speaker" | "both" {
  const v = String(value || "").toLowerCase();
  if (v === "original" || v === "original_speaker") return "original";
  if (v === "speaker" || v === "display") return "speaker";
  return "both";
}

filesCmd
  .command("list")
  .description("List files (most recent first by default)")
  .option("--include-trash", "Include trashed recordings", false)
  .option("--limit <n>", "Max items to return (default: 25)", (v) => Number(v), 25)
  .option("--max <n>", "Deprecated alias for --limit", (v) => Number(v))
  .option("--skip <n>", "Skip N items (API-ordered, not filter-ordered)", (v) => Number(v), 0)
  .option("--all", "Fetch all items (ignores --limit)", false)
  .option("--sort <field>", "Sort field: created|modified (default: created)", "created")
  .option("--order <dir>", "Sort order: desc|asc (default: desc)", "desc")
  .option("--from <iso>", "Only include files on/after this date (YYYY-MM-DD or ISO-8601)")
  .option("--to <iso>", "Only include files on/before this date (YYYY-MM-DD or ISO-8601)")
  .option("--last <duration>", "Shorthand for a recent window like 7d, 30d, 24h (sets --from)")
  .option("--raw", "Include raw API items in JSON output", false)
  .option("--json", "Print JSON")
  .action(
    async (opts: {
      includeTrash?: boolean;
      limit: number;
      max?: number;
      skip: number;
      all?: boolean;
      sort: string;
      order: string;
      from?: string;
      to?: string;
      last?: string;
      raw?: boolean;
      json?: boolean;
    }) => {
    const { listRecordingsPage } = await import("./plaud-api.js");
    const token = await resolveAuthToken();
    const region = await resolveRegion();
    if (!token) {
      if (opts.json) {
        printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." })));
      } else {
        // eslint-disable-next-line no-console
        console.error("No auth token. Use `plaud auth login`, `plaud auth set`, or export `PLAUD_AUTH_TOKEN`.");
      }
      process.exitCode = 2;
      return;
    }

    try {
      const sortBy = String(opts.sort || "created").toLowerCase() === "modified" ? "edit_time" : "start_time";
      const isDesc = String(opts.order || "desc").toLowerCase() !== "asc";

      function parseDate(value: string | undefined): Date | null {
        if (!value) return null;
        const v = String(value).trim();
        if (!v) return null;
        // Allow YYYY-MM-DD as a shorthand.
        const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
        if (Number.isNaN(d.getTime())) return null;
        return d;
      }

      function parseDuration(value: string | undefined): number | null {
        if (!value) return null;
        const v = String(value).trim().toLowerCase();
        const m = v.match(/^(\d+)\s*([smhdw])$/);
        if (!m) return null;
        const n = Number(m[1]);
        const unit = m[2];
        const mult =
          unit === "s"
            ? 1000
            : unit === "m"
              ? 60_000
              : unit === "h"
                ? 3_600_000
                : unit === "d"
                  ? 86_400_000
                  : 7 * 86_400_000;
        return n * mult;
      }

      const lastMs = parseDuration(opts.last);
      const now = Date.now();
      const fromDate = parseDate(opts.from) || (lastMs ? new Date(now - lastMs) : null);
      const toDate = parseDate(opts.to);
      if ((opts.from && !fromDate) || (opts.to && !toDate) || (opts.last && !lastMs)) {
        process.exitCode = 2;
        printJson(
          fail(
            makeError(null, {
              code: "VALIDATION",
              message:
                "Invalid date/duration. Use YYYY-MM-DD or ISO-8601 for --from/--to, and e.g. 7d/24h for --last.",
            }),
          ),
        );
        return;
      }

      const limit = opts.all ? Infinity : Math.max(0, Number.isFinite(opts.max as any) ? Number(opts.max) : Number(opts.limit));
      const skip = Math.max(0, Number(opts.skip || 0));

      const pageFetch = Math.max(50, Math.min(200, Number.isFinite(limit) ? Math.max(50, Math.ceil(limit * 3)) : 200));

      const rawItems: any[] = [];
      const items: Array<{
        id: string;
        name: string;
        durationMs: number | null;
        createdAtMs: number | null;
        createdAt: string | null;
        modifiedAtMs: number | null;
        modifiedAt: string | null;
      }> = [];

      function getNum(v: any): number | null {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }

      function getDurationMs(file: any): number | null {
        return (
          getNum(file?.duration) ??
          getNum(file?.duration_ms) ??
          getNum(file?.audio_duration) ??
          getNum(file?.audio_duration_ms) ??
          null
        );
      }

      function getCreatedMs(file: any): number | null {
        return getNum(file?.start_time) ?? null;
      }

      function getModifiedMs(file: any): number | null {
        return getNum(file?.edit_time) ?? null;
      }

      function matchesWindow(file: any): boolean {
        const createdMs = getCreatedMs(file);
        const modifiedMs = getModifiedMs(file);
        const sortMs = sortBy === "edit_time" ? modifiedMs : createdMs;
        const ms = sortMs ?? createdMs ?? modifiedMs;
        if (!ms) return true;
        if (fromDate && ms < fromDate.getTime()) return false;
        if (toDate && ms > toDate.getTime()) return false;
        return true;
      }

      function msToIso(ms: number | null): string | null {
        if (!ms) return null;
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString();
      }

      let rawSkip = skip;
      let scanned = 0;
      let returned = 0;
      let hasMore = false;

      // If filters are provided, we may need to scan multiple API pages to fill a single logical page.
      // Note: pagination is still based on API ordering (skip/limit), and `nextSkip` is safe to use for continuation.
      while (returned < (Number.isFinite(limit) ? limit + 1 : Infinity)) {
        const batch = await listRecordingsPage({
          token,
          region,
          includeTrash: !!opts.includeTrash,
          sortBy,
          isDesc,
          skip: rawSkip,
          limit: pageFetch,
        });
        if (!batch.length) break;

        for (const file of batch) {
          rawSkip += 1;
          scanned += 1;

          if (!matchesWindow(file)) continue;
          if (opts.raw) rawItems.push(file);

          const createdAtMs = getCreatedMs(file);
          const modifiedAtMs = getModifiedMs(file);
          const id = String(file?.id || "");
          const name = String(file?.filename || file?.name || "");
          if (!id) continue;

          items.push({
            id,
            name,
            durationMs: getDurationMs(file),
            createdAtMs,
            createdAt: msToIso(createdAtMs),
            modifiedAtMs,
            modifiedAt: msToIso(modifiedAtMs),
          });
          returned += 1;

          if (Number.isFinite(limit) && returned >= limit + 1) break;
        }

        if (Number.isFinite(limit) && returned >= limit + 1) break;
        if (batch.length < pageFetch) break;

        // Best-effort early-exit: if we're sorted desc by the same field used for the window, and the last item is older than fromDate,
        // there will be no more matches.
        if (fromDate && isDesc && batch.length) {
          const last = batch[batch.length - 1];
          const lastMs = sortBy === "edit_time" ? getModifiedMs(last) : getCreatedMs(last);
          if (lastMs && lastMs < fromDate.getTime()) break;
        }
      }

      if (Number.isFinite(limit) && items.length > limit) {
        hasMore = true;
        items.length = limit;
      }

      if (opts.json) {
        const data: any = {
          count: items.length,
          items,
          page: {
            limit: Number.isFinite(limit) ? limit : null,
            skip,
            nextSkip: rawSkip,
            hasMore,
            scanned,
          },
          sort: { field: sortBy === "edit_time" ? "modified" : "created", order: isDesc ? "desc" : "asc" },
          filter: { from: fromDate ? fromDate.toISOString() : null, to: toDate ? toDate.toISOString() : null },
        };
        if (opts.raw) data.recordings = rawItems;
        printJson(ok(data, { includeTrash: !!opts.includeTrash }));
        return;
      }

      function formatDuration(ms: number | null): string {
        if (!ms || ms < 0) return "-";
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
      }

      function formatDateTime(ms: number | null): string {
        if (!ms) return "-";
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return "-";
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
      }

      const createdWidth = 16;
      const durWidth = 10;
      const idWidth = 8;

      // eslint-disable-next-line no-console
      console.log(`${"Created".padEnd(createdWidth)} ${"Duration".padEnd(durWidth)} ${"ID".padEnd(idWidth)} Name`);
      // eslint-disable-next-line no-console
      console.log(`${"-".repeat(createdWidth)} ${"-".repeat(durWidth)} ${"-".repeat(idWidth)} ${"-".repeat(20)}`);
      for (const it of items) {
        const idShort = it.id.slice(0, idWidth);
        // eslint-disable-next-line no-console
        console.log(`${formatDateTime(it.createdAtMs).padEnd(createdWidth)} ${formatDuration(it.durationMs).padEnd(durWidth)} ${idShort.padEnd(idWidth)} ${it.name}`);
      }
      if (hasMore) {
        // eslint-disable-next-line no-console
        console.log(`\nMore available. Next page: plaud files list --skip ${rawSkip} --limit ${Number.isFinite(limit) ? limit : 25}`);
      }
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) {
        printJson(fail(makeError(err)));
        return;
      }
      throw err;
    }
  },
  );

const recordingSpeakersCmd = filesCmd.command("speakers").description("Manage speakers within a single file");

function extractTransResult(details: any): any[] {
  const t = details?.trans_result;
  return Array.isArray(t) ? t : [];
}

function summarizeSpeakerMappings(transResult: any[]): Array<{ originalSpeaker: string; speaker: string; count: number }> {
  const counts = new Map<string, number>();
  for (const seg of transResult) {
    if (!seg || typeof seg !== "object") continue;
    const speaker = typeof (seg as any).speaker === "string" ? String((seg as any).speaker) : "";
    const original =
      typeof (seg as any).original_speaker === "string"
        ? String((seg as any).original_speaker)
        : speaker;
    const key = `${original}\u0000${speaker}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const out = [...counts.entries()].map(([k, count]) => {
    const [originalSpeaker, speaker] = k.split("\u0000");
    return { originalSpeaker, speaker, count };
  });
  out.sort((a, b) => a.originalSpeaker.localeCompare(b.originalSpeaker) || a.speaker.localeCompare(b.speaker));
  return out;
}

recordingSpeakersCmd
  .command("list")
  .description("List speaker labels used in a recording transcript")
  .argument("<id>", "Recording id")
  .option("--json", "Print JSON")
  .action(async (id: string, opts: { json?: boolean }) => {
    const token = await requireToken({ json: !!opts.json });
    const region = await resolveRegion();
    if (!token) return;
    const { getRecordingDetailsBatch } = await import("./plaud-api.js");
    try {
      const list = await getRecordingDetailsBatch({ token, ids: [id], region });
      const details = Array.isArray(list) ? list.find((d: any) => String(d?.id || "") === String(id)) : null;
      if (!details) {
        process.exitCode = 1;
        if (opts.json) {
          printJson(fail(makeError(null, { code: "NOT_FOUND", message: "Recording not found (or details unavailable)." })));
          return;
        }
        // eslint-disable-next-line no-console
        console.error("Recording not found (or details unavailable).");
        return;
      }

      const transResult = extractTransResult(details);
      const mappings = summarizeSpeakerMappings(transResult);
      if (opts.json) {
        printJson(ok({ id, totalSegments: transResult.length, mappings }));
        return;
      }
      // eslint-disable-next-line no-console
      for (const m of mappings) console.log(`${m.originalSpeaker}\t${m.speaker}\t${m.count}`);
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) {
        printJson(fail(makeError(err)));
        return;
      }
      throw err;
    }
  });

recordingSpeakersCmd
  .command("rename")
  .description("Rename a speaker label within a single recording transcript (edits trans_result)")
  .argument("<id>", "Recording id")
  .requiredOption("--from <label>", "Match label (e.g. \"Speaker 2\")")
  .requiredOption("--to <label>", "New display label (e.g. \"Person A\")")
  .option("--match <mode>", "original | speaker | both (default: original)", "original")
  .option("--dry-run", "Show how many segments would change without saving", false)
  .action(async (id: string, opts: any) => {
    const token = await requireToken({ json: true });
    const region = await resolveRegion();
    if (!token) return;
    const { getRecordingDetailsBatch, patchFile } = await import("./plaud-api.js");
    try {
      const list = await getRecordingDetailsBatch({ token, ids: [id], region });
      const details = Array.isArray(list) ? list.find((d: any) => String(d?.id || "") === String(id)) : null;
      if (!details) {
        process.exitCode = 1;
        printJson(fail(makeError(null, { code: "NOT_FOUND", message: "Recording not found (or details unavailable)." })));
        return;
      }

      const from = String(opts.from);
      const to = String(opts.to);
      const match = normalizeMatchMode(opts.match);

      const transResult = extractTransResult(details);
      if (transResult.length === 0) {
        process.exitCode = 2;
        printJson(fail(makeError(null, { code: "VALIDATION", message: "Recording has no trans_result to edit." })));
        return;
      }

      let changed = 0;
      const updated = transResult.map((seg: any) => {
        if (!seg || typeof seg !== "object") return seg;
        const speaker = typeof seg.speaker === "string" ? seg.speaker : "";
        const original = typeof seg.original_speaker === "string" ? seg.original_speaker : "";
        const matches =
          (match === "original" && original === from) ||
          (match === "speaker" && speaker === from) ||
          (match === "both" && (original === from || speaker === from));
        if (!matches) return seg;
        if (speaker === to) return seg;
        changed++;
        return { ...seg, speaker: to };
      });

      if (changed === 0) {
        process.exitCode = 2;
        printJson(
          fail(
            makeError(null, {
              code: "VALIDATION",
              message: "No transcript segments matched. Try `plaud files speakers list <id>` to inspect labels.",
            }),
          ),
        );
        return;
      }

      if (opts.dryRun) {
        printJson(ok({ id, action: "files.speakers.rename", dryRun: true, from, to, match, changed, totalSegments: transResult.length }));
        return;
      }

      const res = await patchFile({ token, fileId: id, body: { trans_result: updated, support_mul_summ: true }, region });
      printJson(ok({ id, action: "files.speakers.rename", dryRun: false, from, to, match, changed, response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

filesCmd
  .command("trash")
  .description("Move recording(s) to trash")
  .argument("<id...>", "Recording id(s)")
  .action(async (ids: string[]) => {
    const token = await requireToken({ json: true });
    const region = await resolveRegion();
    if (!token) return;
    const { trashFiles } = await import("./plaud-api.js");
    try {
      const res = await trashFiles({ token, ids: ids.map(String), region });
      printJson(ok({ ids, action: "trash", response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

filesCmd
  .command("restore")
  .description("Restore recording(s) from trash")
  .argument("<id...>", "Recording id(s)")
  .action(async (ids: string[]) => {
    const token = await requireToken({ json: true });
    const region = await resolveRegion();
    if (!token) return;
    const { untrashFiles } = await import("./plaud-api.js");
    try {
      const res = await untrashFiles({ token, ids: ids.map(String), region });
      printJson(ok({ ids, action: "restore", response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

const recordingTagsCmd = filesCmd.command("tags").description("Manage tags on files");

recordingTagsCmd
  .command("list")
  .description("List available tags")
  .option("--json", "Print JSON")
  .action(async (opts: { json?: boolean }) => {
    const token = await requireToken({ json: !!opts.json });
    const region = await resolveRegion();
    if (!token) return;
    const { listTags } = await import("./plaud-api.js");
    try {
      const tags = await listTags({ token, region });
      if (opts.json) {
        printJson(ok({ count: tags.length, tags }));
        return;
      }
      // eslint-disable-next-line no-console
      for (const t of tags) console.log(`${t.id}\t${t.name}`);
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) printJson(fail(makeError(err)));
      else throw err;
    }
  });

recordingTagsCmd
  .command("add")
  .description("Add a tag to one or more recordings")
  .argument("<tagId>", "Tag id")
  .argument("<id...>", "Recording id(s)")
  .action(async (tagId: string, ids: string[]) => {
    const token = await requireToken({ json: true });
    const region = await resolveRegion();
    if (!token) return;
    const { updateTags } = await import("./plaud-api.js");
    try {
      const res = await updateTags({ token, fileIds: ids.map(String), filetagId: String(tagId), region });
      printJson(ok({ ids, action: "tags.add", tagId, response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

recordingTagsCmd
  .command("clear")
  .description("Clear all tags from one or more recordings")
  .argument("<id...>", "Recording id(s)")
  .action(async (ids: string[]) => {
    const token = await requireToken({ json: true });
    const region = await resolveRegion();
    if (!token) return;
    const { updateTags } = await import("./plaud-api.js");
    try {
      const res = await updateTags({ token, fileIds: ids.map(String), filetagId: "", region });
      printJson(ok({ ids, action: "tags.clear", response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

function inferTransSummPayload(details: any, overrides: { summType?: string; summTypeType?: string }): Record<string, unknown> {
  const tz = typeof details?.timezone === "number" ? details.timezone : 0;
  const tranConfig = details?.extra_data?.tranConfig || {};
  const usedTemplate =
    details?.extra_data?.used_template ||
    details?.extra_data?.aiContentHeader?.used_template ||
    details?.extra_data?.aiContentHeader?.usedTemplate ||
    {};

  const language =
    tranConfig?.language ||
    details?.extra_data?.aiContentHeader?.language_code ||
    details?.extra_data?.aiContentHeader?.languageCode ||
    "en";

  const diarization = typeof tranConfig?.diarization === "number" ? tranConfig.diarization : 1;
  const llm = tranConfig?.llm || "";
  const info: Record<string, unknown> = { language, timezone: tz, diarization };
  if (llm) info.llm = llm;

  const summType =
    overrides.summType ||
    usedTemplate?.template_id ||
    usedTemplate?.templateId ||
    tranConfig?.type ||
    "";
  const summTypeType =
    overrides.summTypeType ||
    usedTemplate?.template_type ||
    usedTemplate?.templateType ||
    tranConfig?.type_type ||
    "custom";

  return {
    is_reload: 1,
    summ_type: String(summType),
    summ_type_type: String(summTypeType),
    info: JSON.stringify(info),
    support_mul_summ: true,
    mark_title: "",
  };
}

filesCmd
  .command("rerun")
  .description("Re-run transcript/summary generation for a recording")
  .argument("<id>", "Recording id")
  .option("--summ-type <id>", "Template id (defaults to inferred from file details)")
  .option("--summ-type-type <type>", "Template type (defaults to inferred)", "custom")
  .option("--wait", "Poll until Plaud no longer reports running tasks for this file", false)
  .option("--timeout-ms <n>", "Wait timeout in ms", (v) => Number(v), 300000)
  .option("--poll-ms <n>", "Poll interval in ms", (v) => Number(v), 2000)
  .action(async (id: string, opts: any) => {
    const token = await requireToken({ json: true });
    const region = await resolveRegion();
    if (!token) return;
    const { getRecordingDetailsBatch, triggerTransSumm, listRunningTasks } = await import("./plaud-api.js");
    try {
      const detailsList = await getRecordingDetailsBatch({ token, ids: [id], region });
      const details = Array.isArray(detailsList) ? detailsList.find((d: any) => String(d?.id || "") === String(id)) : null;
      if (!details) {
        process.exitCode = 1;
        printJson(fail(makeError(null, { code: "NOT_FOUND", message: "Recording not found (or details unavailable)." })));
        return;
      }

      const payload = inferTransSummPayload(details, {
        summType: opts.summType ? String(opts.summType) : undefined,
        summTypeType: opts.summTypeType ? String(opts.summTypeType) : undefined,
      });

      if (!payload.summ_type) {
        process.exitCode = 2;
        printJson(
          fail(
            makeError(null, {
              code: "VALIDATION",
              message: "Could not infer template id. Re-run with `--summ-type <id>` (capture another HAR if needed).",
            }),
          ),
        );
        return;
      }

      const res = await triggerTransSumm({ token, fileId: id, payload, region });

      let waited = false;
      if (opts.wait) {
        waited = true;
        const startedAt = Date.now();
        const timeoutMs = Math.max(10_000, Number(opts.timeoutMs || 300000));
        const pollMs = Math.max(500, Number(opts.pollMs || 2000));
        while (Date.now() - startedAt < timeoutMs) {
          const tasks = await listRunningTasks({ token, region });
          const stillRunning = tasks.filter((t: any) => String(t?.file_id || "") === String(id));
          if (stillRunning.length === 0) break;
          await new Promise((r) => setTimeout(r, pollMs));
        }
      }

      printJson(ok({ id, action: "rerun", waited, payload, response: res }));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

filesCmd
  .command("tasks")
  .description("List running transcription/summary tasks")
  .option("--file-id <id>", "Filter to a specific recording id")
  .option("--json", "Print JSON")
  .action(async (opts: { fileId?: string; json?: boolean }) => {
    const token = await requireToken({ json: !!opts.json });
    const region = await resolveRegion();
    if (!token) return;
    const { listRunningTasks } = await import("./plaud-api.js");
    try {
      const tasks = await listRunningTasks({ token, region });
      const filtered = opts.fileId ? tasks.filter((t: any) => String(t?.file_id || "") === String(opts.fileId)) : tasks;
      if (opts.json) {
        printJson(ok({ count: filtered.length, tasks: filtered }, { filtered: !!opts.fileId }));
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`${filtered.length} running tasks`);
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) printJson(fail(makeError(err)));
      else throw err;
    }
  });

filesCmd
  .command("get")
  .description("Get recording details")
  .argument("<id>", "Recording id")
  .option("--json", "Print JSON")
  .action(async (id: string, opts: { json?: boolean }) => {
    const { getRecordingDetailsBatch } = await import("./plaud-api.js");
    const token = await resolveAuthToken();
    const region = await resolveRegion();
    if (!token) {
      if (opts.json) {
        printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." })));
      } else {
        // eslint-disable-next-line no-console
        console.error("No auth token. Use `plaud auth login`, `plaud auth set`, or export `PLAUD_AUTH_TOKEN`.");
      }
      process.exitCode = 2;
      return;
    }

    try {
      const list = await getRecordingDetailsBatch({ token, ids: [id], region });
      const details = Array.isArray(list) ? list.find((d: any) => String(d?.id || "") === String(id)) : null;
      if (!details) {
        process.exitCode = 1;
        if (opts.json) {
          printJson(fail(makeError(null, { code: "NOT_FOUND", message: "Recording not found" })));
          return;
        }
        // eslint-disable-next-line no-console
        console.error("Recording not found (or details unavailable).");
        return;
      }

      if (opts.json) {
        printJson(ok({ recording: details }));
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`${details.id}  ${details.filename || ""}`.trim());
    } catch (err: any) {
      process.exitCode = 1;
      if (opts.json) {
        printJson(fail(makeError(err)));
        return;
      }
      throw err;
    }
  });

filesCmd
  .command("download")
  .description("Download a single recording's transcript/summary/json/audio")
  .argument("<id>", "Recording id")
  .option("--out <dir>", "Output directory", defaultDownloadDir())
  .option("--what <list>", "Comma-separated: transcript,summary,json,audio", "transcript,summary,json")
  .option("--audio-format <fmt>", "opus or original", "opus")
  .action(async (id: string, opts: { out: string; what: string; audioFormat: string }) => {
    const token = await resolveAuthToken();
    const region = await resolveRegion();
    if (!token) {
      printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." })));
      process.exitCode = 2;
      return;
    }

    try {
      const outDir = path.resolve(String(opts.out || defaultDownloadDir()));
      const result = await downloadRecording({
        token,
        id,
        outDir,
        what: opts.what,
        audioFormat: String(opts.audioFormat || "opus").toLowerCase(),
        region,
      });
      printJson(ok(result));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

filesCmd
  .command("export")
  .description("Export many recordings to a directory or zip (bulk)")
  .option("--include-trash", "Include trashed recordings", false)
  .option("--out <dir>", "Output directory (when not zipping)")
  .option("--zip [path]", "Write a single zip (defaults to ./plaud-transcripts-YYYY-MM-DD.zip)")
  .option("--formats <list>", "Comma-separated: txt,json,md", "txt,json,md")
  .option("--batch-size <n>", "IDs per details request (auto-fallback to 1 on failure)", (v) => Number(v), 10)
  .option("--delay-ms <n>", "Delay between batches (ms)", (v) => Number(v), 300)
  .option("--max <n>", "Max recordings to export", (v) => Number(v), Infinity)
  .option("--since <iso>", "Only export recordings on/after this date (ISO string or YYYY-MM-DD)")
  .option("--until <iso>", "Only export recordings on/before this date (ISO string or YYYY-MM-DD)")
  .option("--resume", "Skip writing files that already exist (dir mode)", false)
  .action(async (opts: any) => {
    const token = await resolveAuthToken();
    const region = await resolveRegion();
    if (!token) {
      printJson(fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." })));
      process.exitCode = 2;
      return;
    }

    try {
      const formatsList = new Set(splitCsv(opts.formats).map((f) => f.toLowerCase()));
      const formats = {
        txt: formatsList.has("txt"),
        json: formatsList.has("json"),
        md: formatsList.has("md") || formatsList.has("markdown"),
      };

      const zipPath =
        typeof opts.zip === "string" ? path.resolve(opts.zip) : opts.zip ? defaultZipPath() : null;
      const outDir = path.resolve(opts.out || defaultOutDir());

      if (!zipPath) {
        await fs.mkdir(outDir, { recursive: true });
      }

      let lastRendered = 0;
      const summary = await exportRecordings({
        token,
        outDir,
        zipPath,
        includeTrash: !!opts.includeTrash,
        formats,
        batchSize: Math.max(1, Number(opts.batchSize || 10)),
        delayMs: Math.max(0, Number(opts.delayMs || 300)),
        max: Number.isFinite(opts.max) ? opts.max : Infinity,
        since: opts.since || null,
        until: opts.until || null,
        resume: !!opts.resume,
        region,
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastRendered < 200) return;
          lastRendered = now;
          // eslint-disable-next-line no-console
          process.stderr.write(`\rExporting ${p.current}/${p.total}...`);
        },
      });

      // eslint-disable-next-line no-console
      process.stderr.write("\n");
      printJson(ok(summary));
    } catch (err: any) {
      process.exitCode = 1;
      printJson(fail(makeError(err)));
    }
  });

program
  .command("whoami")
  .description("Fetch the current Plaud user profile")
  .option("--json", "Print JSON")
  .option("--raw", "Print raw /user/me response (may include signed URLs)", false)
  .action(async (opts: { json?: boolean; raw?: boolean }) => {
    const { getMe } = await import("./plaud-api.js");
    const token = await resolveAuthToken();
    const region = await resolveRegion();
    if (!token) {
      const out = fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." }));
      // eslint-disable-next-line no-console
      console.log(opts.json ? JSON.stringify(out, null, 2) : out.error.message);
      process.exitCode = 2;
      return;
    }
    let me: any;
    if (opts.raw) {
      me = await getMe({ token, region });
    } else {
      const validation = await validateToken(token, region);
      if (!validation.ok) {
        const out = fail(makeError(null, { code: "AUTH_INVALID", message: validation.reason || "Token invalid" }));
        // eslint-disable-next-line no-console
        console.log(opts.json ? JSON.stringify(out, null, 2) : out.error.message);
        process.exitCode = 1;
        return;
      }
      me = validation.me;
    }
    if (opts.json) {
      printJson(ok({ me, raw: !!opts.raw }));
      return;
    }
    const label = pickUserLabel(me);
    // eslint-disable-next-line no-console
    console.log(label || "OK");
  });

program
  .command("doctor")
  .description("Run basic checks for auth and API access")
  .option("--json", "Print JSON")
  .action(async (opts: { json?: boolean }) => {
    const checks: Array<{ name: string; ok: boolean; detail?: string | null }> = [];
    const token = await resolveAuthToken();
    const region = await resolveRegion();
    checks.push({ name: "token.present", ok: !!token });

    if (!token) {
      const out = fail(makeError(null, { code: "AUTH_MISSING", message: "No auth token. Run `plaud auth login`." }), { checks });
      // eslint-disable-next-line no-console
      console.log(opts.json ? JSON.stringify(out, null, 2) : out.error.message);
      process.exitCode = 2;
      return;
    }

    const validation = await validateToken(token, region);
    checks.push({ name: "token.valid", ok: validation.ok, detail: validation.ok ? null : validation.reason });

    try {
      const { listRecordings } = await import("./plaud-api.js");
      await listRecordings({ token, includeTrash: false, max: 1, pageSize: 1, region });
      checks.push({ name: "api.listRecordings", ok: true });
    } catch (error: any) {
      checks.push({ name: "api.listRecordings", ok: false, detail: error?.message || String(error) });
    }

    const allOk = checks.every((c) => c.ok);
    const out = allOk
      ? ok({ checks })
      : fail(makeError(null, { code: "CHECK_FAILED", message: "One or more checks failed" }), { checks });
    // eslint-disable-next-line no-console
    console.log(opts.json ? JSON.stringify(out, null, 2) : allOk ? "OK" : "Some checks failed");
    if (!allOk) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err: any) => {
  // eslint-disable-next-line no-console
  console.error(err?.message || err);
  process.exitCode = 1;
});
