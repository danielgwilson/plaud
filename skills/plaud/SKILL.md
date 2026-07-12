---
name: plaud
description: Use this skill whenever you need to list/search/download/export Plaud files (audio, transcripts, AI summaries), manage tags/speakers, or trash/restore items from app.plaud.ai using the plaud CLI (agent-first, JSON-friendly).
---

# Plaud (agent-first CLI)

Use this skill to pull content out of Plaud in a way that’s reliable for agents: stable `--json` envelopes, local search, explicit paging/filters, and honest coverage boundaries.

## Prime directive: optimize for recall

Completeness and accuracy matter more than efficiency. Treat every search result as a candidate set until you have checked the coverage warnings and run enough compensating searches.

Hard filters and tidy result lists are not proof of completeness:

- A speaker/name search only finds recordings where the name was detected, labeled, or appears in searchable text. It can miss unlabeled `Speaker 1` / `Speaker 2` recordings.
- An exact project search can miss allusions, nicknames, old names, misspellings, and conversations where the project is implied but never named.
- Date filters can hide older context or recordings with surprising timestamps.
- A clipped top-N result list can hide additional candidates. If `data.coverage.riskFactors.truncated` is true, increase `--limit` and keep triangulating.
- Generic speaker terms, very short aliases, and broad multi-term fuzzy queries are high-risk candidate generators, not evidence of completeness.
- `--ids-only` protects tokens and privacy, but it does not make the result exhaustive.
- `--snippets` validates candidates; it does not prove that non-returned recordings are irrelevant.

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

## Recall-first search workflow

For comprehensive retrieval, do not stop after one exact query or one filter.

1. Start with a broad local store query:
   - `plaud files search "topic or person" --ids-only --json`
2. Read `meta.coverageWarnings` and `data.coverage.riskFactors` before judging completeness.
   - If `truncated` is true, increase `--limit` and treat the first response as incomplete.
   - If warnings mention generic speaker terms, short aliases, or multi-term fuzzy search, add more precise/adjacent queries before making a claim.
3. Run adjacent searches:
   - aliases: `Alex`, `Alex R.`, `Alex Rivera`
   - project variants: `Project Atlas`, `Atlas project`, old names, related people, adjacent domain terms
   - people/context: cofounders, advisors, customers, topic terms, dates
   - unlabeled-speaker risk: `Speaker 1`, `Speaker 2`, `unknown`, title-known names
4. Use `--from` / `--to` to narrow only after a broad pass has established the likely time range.
5. Use `--snippets` only on likely candidates or query variants that need validation.
6. For final answers, state the coverage receipt: queries used, broad counts, high-confidence IDs, suspected misses, and why filters may be lossy.

Bad pattern:

> `plaud files search "Project Atlas"` returned two results, so these are all Project Atlas conversations.

Good pattern:

> Exact search for `Project Atlas` returned two direct hits. Adjacent searches for related people and domain language returned more candidates, so I am treating the exact hits as confirmed direct matches and the adjacent hits as review candidates. Coverage remains non-exhaustive because allusions, unlabeled speakers, and missing transcript/summary text can hide relevant recordings.

For hard fuzzy asks such as "emotionally charged founder conversations" or "entries where unnamed speakers are actually known", build a small query matrix first. Include direct terms, aliases, adjacent people, emotional/domain vocabulary, and generic speaker terms. Review snippets/transcripts for the resulting candidate set before making a completeness claim.

Example for a person:

```bash
plaud files search "Alex Rivera" --ids-only --json
plaud files search "Alex" --ids-only --json
plaud files search "A. Rivera" --ids-only --json
plaud files search "Speaker 1 Alex" --ids-only --json
```

Example for an alluded-to project:

```bash
plaud files search "Project Atlas" --ids-only --json
plaud files search "billing analytics migration" --ids-only --json
plaud files search "invoice provenance audit truth" --ids-only --json
plaud files search "founder customer advisor rollout" --snippets --json
```

## Paging and filtering (precision tools, not proof)

- Prefer filters over dumping everything only after you have considered recall risk:
  - Last N: `plaud files list --json --last 30d --limit 50`
  - Date range: `plaud files list --json --from 2026-02-01 --to 2026-03-01 --limit 50`
- Page forward: `plaud files list --json --skip 50 --limit 50`
- If results change during paging, anchor with `--to` (or use a narrower range) and retry.
- If a user asks for "all", "complete", "comprehensive", or "thorough", filters are only one evidence source. Add a broad recall pass and explicitly report known blind spots.

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
- `files search --json` includes `data.coverage` and `meta.coverageWarnings`; read them before making claims about completeness.

## Public-package note

This is an unofficial CLI. Prefer Plaud's official tooling for supported auth and ordinary terminal use; use this CLI when you need JSON-first export, local store search, or de-duplication.
