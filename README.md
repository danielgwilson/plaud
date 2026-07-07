# plaud

![CI](https://github.com/danielgwilson/plaud/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/plaud)

Export, sync, search, and de-duplicate Plaud recordings with speaker-labeled transcripts and optional AI summaries.

## Official Plaud Tools Exist Now

Plaud now ships official tooling. For supported auth and general terminal use, start with Plaud's official CLI:

```bash
npm install -g @plaud-ai/cli
```

Official docs:
- [Plaud CLI](https://docs.plaud.ai/plaud-mcp-cli/cli)
- [Plaud MCP](https://docs.plaud.ai/plaud-mcp-cli/mcp)

This package remains an **unofficial advanced exporter** for JSON-first and bulk workflows that Plaud's official CLI does not yet cover. Use it when you specifically need stable machine-readable output, bulk transcript/summary export, ZIP export, or the packaged agent skill.

## Disclaimer

This is an **unofficial** project (not affiliated with Plaud). It uses a captured Plaud bearer token and private web endpoints, so it may break if Plaud changes their web app.

Operational note: Plaud's private web API may reject non-browser request fingerprints at the edge even when the bearer token is valid. The CLI sends browser-like request headers, including a web user-agent, to match Plaud's web app requests.

Security note: **do not** share tokens or `*.har` files (HARs often contain `Authorization` headers).

## Terminology

Plaud’s web UI uses “Files”. This CLI uses `files` as the primary command group, with `recordings` kept as an alias for compatibility: `plaud files …` (preferred) or `plaud recordings …`.

## Install (npm)

Global (recommended for frequent use):

```bash
npm i -g plaud
plaud auth login
```

No install (convenient for agents/one-offs):

```bash
npx -y plaud auth status --json
```

## Install (skill)

```bash
npx -y skills add -g danielgwilson/plaud --skill plaud
```

## Publishing (maintainers)

This repo is configured for npm **trusted publishing** from GitHub Actions.

- Workflow: `.github/workflows/publish.yml`
- npm Trusted Publisher workflow filename: `publish.yml`

## Install (local)

```bash
cd plaud/plaud-cli
npm install
npm link
```

Requirements:
- Node.js 22+ (tested on Node 24)

## Auth

Preferred (easy onboarding, stores token locally):

```bash
plaud auth login
```

Verify:

```bash
plaud auth status
plaud doctor
```

Fallbacks:

```bash
plaud auth set --stdin
plaud auth import-har /path/to/web.plaud.ai.har
```

Or via env var (no local storage):

```bash
export PLAUD_AUTH_TOKEN="eyJ..."
```

Tip (Node 22+): you can also use Node’s `--env-file` if you want to load a local `.env` without adding any dependency to the CLI:

```bash
node --env-file .env "$(command -v plaud)" auth status --json
```

## Export

Create a single ZIP (default):

```bash
plaud files export --zip
```

Export to a directory:

```bash
plaud files export --out ./plaud-transcripts --formats txt,json,md
```

## Download a single recording

```bash
plaud files list --json --limit 10
plaud files download <id> --out ./plaud-download --what transcript,summary,json
plaud files download <id> --out ./plaud-download --what audio --audio-format opus
```

## Local Store, Search, and De-Dupe

For larger libraries, sync file details into a private local store. The store is local-only, content-addressed, and kept outside the current working directory by default.

```bash
plaud files sync
plaud files search "project kickoff"
plaud files dupes --by content
plaud store status
plaud store path
plaud store verify
```

The default store location follows the OS data directory conventions. You can override it per command or process:

```bash
plaud files sync --store ./scratch-store --max 50
PLAUD_STORE_DIR=./scratch-store plaud files search "follow up"
```

De-dupe is intentionally conservative:
- a rename or metadata edit creates a new snapshot
- unchanged transcript or summary content reuses the existing content blob
- `plaud files dupes --by content` groups matching transcript/summary content
- `plaud files dupes --by snapshot` only groups fully identical snapshots

Use `plaud store clear --yes` to delete the local store. This never clears Plaud cloud data.

Notes:
- `plaud files export` prints a JSON summary to stdout; progress goes to stderr.
- `plaud files sync` prints a JSON summary to stdout; progress goes to stderr.
- (`plaud recordings …` is supported as an alias for `plaud files …`.)
- Tokens are stored at `~/.config/plaud/config.json` with `0600` permissions.

## Agent-first JSON contract

See `docs/CONTRACT_V1.md`.
