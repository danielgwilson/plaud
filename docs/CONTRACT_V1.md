# Plaud CLI v1 contract (agent-first)

This document defines **stable**, machine-readable behavior for agents and scripts.

Note: `plaud recordings …` is supported as an alias for `plaud files …`.

## Output rules

- When you pass `--json`, the command prints **exactly one JSON object** to stdout.
- Progress/status logs go to **stderr**.
- For mutation-style commands, stdout is always JSON (even without `--json`):
  - `plaud files download`
  - `plaud files export`
  - `plaud files trash`
  - `plaud files restore`
  - `plaud files tags add`
  - `plaud files tags clear`
  - `plaud files rerun`
  - `plaud files speakers rename`
  - `plaud files sync`
  - `plaud files search`
  - `plaud files dupes`
  - `plaud store verify`
  - `plaud store clear`

## JSON envelope

### Success

```json
{
  "ok": true,
  "data": {},
  "meta": {}
}
```

`meta` is optional.

### Failure

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_MISSING",
    "message": "No auth token. Run `plaud auth login`.",
    "retryable": false,
    "http": { "status": 401 }
  },
  "meta": {}
}
```

`error.http` and `meta` are optional.

## Exit codes

- `0`: success
- `1`: failure (unexpected, transient, or upstream error)
- `2`: user action required (missing auth, invalid input, invalid HAR, etc.)

## Error codes

These are best-effort and may expand in the future:

- `AUTH_MISSING` (exit `2`)
- `AUTH_INVALID` (usually exit `1`)
- `NOT_FOUND` (exit `1`)
- `RATE_LIMITED` (exit `1`, `retryable: true`)
- `UPSTREAM_5XX` (exit `1`, `retryable: true`)
- `TIMEOUT` (exit `1`, `retryable: true`)
- `VALIDATION` (exit `2`)
- `CHECK_FAILED` (exit `1`)
- `UNKNOWN` (exit `1`)

## Commands (JSON schemas by example)

### `plaud auth show --json`

Success:
```json
{
  "ok": true,
  "data": { "hasToken": true, "source": "config", "tokenRedacted": "eyJhbG…abcd" }
}
```

Failure (`exit 2`):
```json
{
  "ok": false,
  "error": { "code": "AUTH_MISSING", "message": "No token set", "retryable": false },
  "meta": { "hasToken": false }
}
```

### `plaud auth status --json`

Success:
```json
{
  "ok": true,
  "data": {
    "hasToken": true,
    "source": "config",
    "tokenRedacted": "eyJhbG…abcd",
    "validation": { "ok": true, "me": { "status": 0, "user": { "email": "…" } } }
  }
}
```

### `plaud auth login --json`

Success:
```json
{
  "ok": true,
  "data": { "tokenRedacted": "eyJhbG…abcd", "validation": { "ok": true, "me": { "user": { "email": "…" } } } }
}
```

Notes:
- This flow opens a browser and captures a Plaud bearer token from an authenticated request to `api.plaud.ai`.
- Plaud's private web API may reject non-browser request fingerprints at the edge. The CLI intentionally sends browser-like request headers, including a web user-agent, so valid tokens continue to behave like Plaud web-app requests.

### `plaud auth set --json`

Success:
```json
{ "ok": true, "data": { "saved": true, "tokenRedacted": "eyJhbG…abcd" } }
```

### `plaud auth import-har /path/to.har --json`

Success:
```json
{ "ok": true, "data": { "imported": true, "tokenRedacted": "eyJhbG…abcd" } }
```

### `plaud auth clear --json`

Success:
```json
{ "ok": true, "data": { "cleared": true } }
```

### `plaud whoami --json`

Success:
```json
{ "ok": true, "data": { "me": { "user": { "email": "…" } }, "raw": false } }
```

Notes:
- `--raw` returns the full `/user/me` response and may include signed URLs.

### `plaud doctor --json`

Success:
```json
{ "ok": true, "data": { "checks": [{ "name": "token.present", "ok": true }] } }
```

Failure:
```json
{
  "ok": false,
  "error": { "code": "CHECK_FAILED", "message": "One or more checks failed", "retryable": false },
  "meta": { "checks": [{ "name": "api.listRecordings", "ok": false, "detail": "…" }] }
}
```

### `plaud files list --json`

Success:
```json
{
  "ok": true,
  "data": {
    "count": 2,
    "items": [
      {
        "id": "…",
        "name": "…",
        "durationMs": 1234,
        "createdAtMs": 1700000000000,
        "createdAt": "2024-01-01T00:00:00.000Z",
        "modifiedAtMs": 1700000000000,
        "modifiedAt": "2024-01-01T00:00:00.000Z"
      }
    ],
    "page": { "limit": 25, "skip": 0, "nextSkip": 25, "hasMore": true, "scanned": 25 },
    "sort": { "field": "created", "order": "desc" },
    "filter": { "from": null, "to": null }
  },
  "meta": { "includeTrash": false }
}
```

### `plaud files get <id> --json`

Success:
```json
{ "ok": true, "data": { "recording": { "id": "…", "trans_result": [] } } }
```

Failure (not found):
```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "Recording not found", "retryable": false } }
```

### `plaud files download <id>`

Success:
```json
{
  "ok": true,
  "data": {
    "id": "…",
    "outDir": "/abs/path",
    "written": [{ "kind": "audio", "path": "/abs/path/file.opus", "bytes": 123 }]
  }
}
```

Notes:
- `--what` supports: `transcript,summary,json,audio`
- `--audio-format` supports: `opus` (preferred) or `original`

### `plaud files export`

Success:
```json
{
  "ok": true,
  "data": {
    "exportDate": "2026-02-28T00:00:00.000Z",
    "totalFiles": 10,
    "successful": 10,
    "failed": [],
    "includesTrash": false,
    "since": null,
    "until": null,
    "outDir": null,
    "zipPath": "/abs/path.zip"
  }
}
```

### `plaud files sync`

Success:
```json
{
  "ok": true,
  "data": {
    "storeDir": "/abs/store",
    "scanned": 10,
    "selected": 10,
    "changed": 2,
    "unchanged": 8,
    "currentChanged": 2,
    "blobWrites": 4,
    "failed": [],
    "status": { "recordings": 10, "snapshots": 12, "blobs": 30 }
  },
  "meta": {
    "includeTrash": false,
    "what": { "json": true, "transcript": true, "summary": true }
  }
}
```

Notes:
- Sync writes a private local store outside the current working directory by default.
- Sync stores readable local JSON details, transcript text, and summary text unless narrowed with `--what`.
- A metadata edit such as a rename creates a new snapshot.
- Unchanged transcript/summary content reuses existing content-addressed blobs.

### `plaud files search <query>`

Success:
```json
{
  "ok": true,
  "data": {
    "storeDir": "/abs/store",
    "totalIndexed": 10,
    "items": [
      {
        "id": "synthetic-id",
        "snapshotHash": "sha256...",
        "name": "Synthetic title",
        "score": 1.23,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "modifiedAt": "2026-01-01T00:00:00.000Z",
        "durationMs": 1234,
        "snippet": null,
        "hashes": { "snapshot": "sha256...", "metadata": "sha256...", "details": "sha256..." }
      }
    ],
    "coverage": {
      "exhaustive": false,
      "mode": "text",
      "fieldsSearched": ["name", "transcript", "summary", "tags", "speakers"],
      "warnings": [
        "Search results are candidates, not proof of exhaustive corpus coverage."
      ],
      "riskFactors": {
        "totalIndexedAfterFilters": 10,
        "dateFiltered": false,
        "historicalSnapshotsIncluded": false,
        "snippetsIncluded": false,
        "genericSpeakerRecords": 3,
        "recordsWithoutSpeakers": 0,
        "missingTranscriptRecords": 0,
        "missingSummaryRecords": 0,
        "candidateRecordsBeforeLimit": 10,
        "returnedLimit": 20,
        "truncated": false
      }
    }
  },
  "meta": {
    "localOnly": true,
    "snippets": false,
    "coverageWarnings": [
      "Search results are candidates, not proof of exhaustive corpus coverage."
    ]
  }
}
```

Notes:
- Search output is metadata-only by default, but matching uses available local title, transcript, summary, tag, and speaker text.
- Pass `--snippets` to include snippets from local transcript/summary content.
- Pass `--ids-only` for compact agent-safe result lists.
- `coverage.exhaustive` is always `false`; filters and searches produce candidates, not proof that no relevant recording exists elsewhere.
- `riskFactors.truncated` means more candidate records existed than were returned. Increase `--limit` and keep triangulating before claiming completeness.
- Speaker/name searches depend on detected local speaker metadata and searchable text. Generic speakers such as `Speaker 1` can hide relevant recordings.
- `coverage.warnings` also flags high-risk query shapes such as generic speaker terms, very short aliases, and broad multi-term fuzzy searches.
- For comprehensive retrieval, combine exact terms with aliases, adjacent people, broad topical searches, date sweeps, generic-speaker checks, and targeted transcript review.
- Completeness-oriented answers should include a coverage receipt: queries, filters, result counts, confirmed IDs, suspected misses, and known lossy assumptions.

Failure when no query is provided:
```json
{ "ok": false, "error": { "code": "VALIDATION", "message": "Provide a query or pass --all to list local records.", "retryable": false } }
```

Failure when a date filter is invalid:
```json
{ "ok": false, "error": { "code": "VALIDATION", "message": "Invalid --from date. Use YYYY-MM-DD or ISO-8601.", "retryable": false } }
```

### `plaud files dupes`

Success:
```json
{
  "ok": true,
  "data": {
    "storeDir": "/abs/store",
    "by": "content",
    "groups": [
      {
        "hash": "sha256...",
        "count": 2,
        "items": [{ "id": "synthetic-id", "snapshotHash": "sha256...", "name": "Synthetic title" }]
      }
    ]
  },
  "meta": { "localOnly": true }
}
```

Failure when `--by` is invalid:
```json
{ "ok": false, "error": { "code": "VALIDATION", "message": "Invalid --by value \"bogus\". Use snapshot, metadata, details, transcript, text, summary, or content.", "retryable": false } }
```

### `plaud store status --json`

Success:
```json
{ "ok": true, "data": { "storeDir": "/abs/store", "recordings": 10, "snapshots": 12, "blobs": 30, "updatedAt": "2026-01-01T00:00:00.000Z" } }
```

### `plaud store verify`

Success:
```json
{ "ok": true, "data": { "storeDir": "/abs/store", "recordings": 10, "snapshots": 12, "blobs": 30, "ok": true, "missing": [] } }
```

### `plaud store clear --yes`

Success:
```json
{ "ok": true, "data": { "storeDir": "/abs/store", "removed": true } }
```

Notes:
- `store clear` refuses filesystem root, home-directory parents, and current-working-directory parents.
- Existing custom store directories must contain a Plaud store index unless `--i-understand-this-deletes-arbitrary-path` is passed.

### `plaud files trash <id...>`

Success:
```json
{ "ok": true, "data": { "ids": ["…"], "action": "trash", "response": { "status": 0 } } }
```

### `plaud files restore <id...>`

Success:
```json
{ "ok": true, "data": { "ids": ["…"], "action": "restore", "response": { "status": 0 } } }
```

### `plaud files tags list --json`

Success:
```json
{ "ok": true, "data": { "count": 1, "tags": [{ "id": "…", "name": "…" }] } }
```

### `plaud files tags add <tagId> <id...>`

Success:
```json
{ "ok": true, "data": { "ids": ["…"], "action": "tags.add", "tagId": "…", "response": { "status": 0 } } }
```

### `plaud files tags clear <id...>`

Success:
```json
{ "ok": true, "data": { "ids": ["…"], "action": "tags.clear", "response": { "status": 0 } } }
```

### `plaud files rerun <id>`

Success:
```json
{ "ok": true, "data": { "id": "…", "action": "rerun", "waited": false, "response": { "status": 0 } } }
```

### `plaud files tasks --json`

Success:
```json
{ "ok": true, "data": { "count": 2, "tasks": [{ "file_id": "…", "task_type": "transcript" }] } }
```

### `plaud files speakers list <id> --json`

Success:
```json
{ "ok": true, "data": { "id": "…", "totalSegments": 162, "mappings": [{ "originalSpeaker": "Speaker 2", "speaker": "Person A", "count": 10 }] } }
```

### `plaud files speakers rename <id> --from "Speaker 2" --to "Person A"`

Success:
```json
{ "ok": true, "data": { "id": "…", "action": "files.speakers.rename", "dryRun": false, "changed": 10 } }
```
