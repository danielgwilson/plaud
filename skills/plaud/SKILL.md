---
name: plaud
description: Use this skill whenever you need to list/search/download/export Plaud files (audio, transcripts, AI summaries), manage tags/speakers, or trash/restore items from app.plaud.ai using the plaud CLI (agent-first, JSON-friendly).
---

# Plaud (agent-first CLI)

Use this skill to pull content out of Plaud in a way that’s reliable for agents: small defaults, stable `--json` envelopes, and explicit paging/filters.

## Default workflow (read-only)

- Sanity check: `plaud doctor --json`
- Browse recent files: `plaud files list --limit 25` (table) or `plaud files list --json --limit 25`
- Drill in: `plaud files get <id> --json`
- Pull content into an explicit scratch/export directory: `plaud files download <id> --out <dir> --what transcript,summary,json`

## Common tasks

- Download audio: `plaud files download <id> --out <dir> --what audio --audio-format opus`
- Bulk export a scoped range: `plaud files export --zip --since 2026-01-01 --until 2026-02-01`
- Local store search: `plaud files sync --max 200`, then `plaud files search "keyword" --ids-only`
- Include snippets only when transcript/summary excerpts are appropriate for stdout: `plaud files search "keyword" --snippets`
- Trash / restore: `plaud files trash <id>` and `plaud files restore <id>`
- Tags: `plaud files tags list --json`, `plaud files tags add <tagId> <id>`, `plaud files tags clear <id>`
- Speaker labels (per recording): `plaud files speakers list <id> --json` and `plaud files speakers rename <id> --from "Speaker 2" --to "Person A"`
- Re-run transcript/summary: `plaud files rerun <id> --wait`

## Paging and filtering (agent ergonomics)

- Prefer filters over “dump everything”:
  - Last N: `plaud files list --json --last 30d --limit 50`
  - Date range: `plaud files list --json --from 2026-02-01 --to 2026-03-01 --limit 50`
- Page forward: `plaud files list --json --skip 50 --limit 50`
- If results change during paging, anchor with `--to` (or use a narrower range) and retry.

## Auth (only when needed)

If `plaud doctor --json` indicates missing auth:

- Best UX (interactive): `plaud auth login` (opens a browser, captures token, closes when done)
- Headless/remote:
  - Copy `~/.config/plaud/config.json` from a trusted machine, or
  - `plaud auth set --stdin` (paste token via stdin), or
  - `PLAUD_AUTH_TOKEN=... plaud doctor --json` (ephemeral; avoid saving)
- HAR import exists (`plaud auth import-har ...`) but is a last resort (HARs often contain sensitive data).

## Hard constraints (security)

- Never print/paste full tokens or HAR contents into chat/logs.
- Never pass tokens via CLI flags (use login/stdin/config/env).
- Prefer `--json` outputs; treat non-JSON text as human-only.
- `plaud files sync` stores readable local JSON details, transcript text, and summary text unless narrowed with `--what`; set `PLAUD_STORE_DIR` for scratch/temporary runs.
- Do not paste transcript/summary snippets into public issues, docs, or logs unless the user explicitly asks.

## JSON contract (for tool use)

- Stable machine-readable behavior is documented in `docs/CONTRACT_V1.md`.

## Public-package note

This is an unofficial CLI. Prefer Plaud's official tooling for supported auth and ordinary terminal use; use this CLI when you need JSON-first export, local store search, or de-duplication.
