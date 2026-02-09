# Job Engine

Job Engine ingests jobs from multiple sources, deduplicates them into a single queue, and provides a fast review UI with provenance and run diagnostics.

## Features

- Multi-source ingestion: Greenhouse, Lever, SerpAPI (Google Jobs), Amazon
- Canonical deduplication with fingerprint tracking
- Ingestion run history and source-level error visibility
- Provenance for each job (where it came from and when it was seen)
- Review workflow: inbox -> approved/skipped/applied
- Optional sync to personal dashboard when job is marked `applied`

## Quick Start

```bash
cd job-engine
npm install
npm test
npm run dev
```

Open:

- UI: `http://localhost:3030/`
- Health: `GET /health`

## Configuration

### Core sources

```bash
export GREENHOUSE_BOARDS="https://boards.greenhouse.io/company-a,https://boards.greenhouse.io/company-b"
export LEVER_BOARDS="https://jobs.lever.co/company-a"

export SERPAPI_KEY="<your-key>"
export SERPAPI_QUERIES="software engineer toronto,backend engineer toronto"
export SERPAPI_LOCATION="Toronto, ON, Canada"
```

### Scheduler

```bash
export FETCH_INTERVAL_MIN=15
export RUN_ON_STARTUP=true
```

### Big-tech run (optional)

```bash
export BIGTECH_GREENHOUSE_BOARDS="https://boards.greenhouse.io/company-x"
export BIGTECH_LEVER_BOARDS="https://jobs.lever.co/company-y"
export BIGTECH_AMAZON_QUERIES="software engineer,new grad"
export BIGTECH_AMAZON_LOCATIONS="Toronto, ON, Canada,Remote"
export BIGTECH_FETCH_INTERVAL_MIN=1440
```

### Personal dashboard sync (optional)

```bash
export PD_WEBHOOK_URL="https://your-dashboard/webhook"
export PD_WEBHOOK_TOKEN="<token>"
export PD_DB_PATH="/path/to/personal-dashboard/data/messages.db"
```

## API

### Jobs

- `GET /jobs`
  - Filters: `tier`, `status`, `source`, `q`, `minScore`, `bigtech=true`, `hasErrors=true`, `seenWithinDays`
  - Pagination: `page`, `pageSize`
  - Returns `{ items, meta }`
  - Legacy mode: `GET /jobs?legacy=true` returns array only
- `GET /jobs/:id/provenance`
  - Returns source history + event trail for a job
- `POST /jobs/:id/status`
  - Body: `{ "status": "approved" | "skipped" | "applied" }`
  - Returns updated job snapshot and optional `syncWarning`

### Scheduler / Ingestion

- `POST /api/scheduler/run`
  - Manually trigger core run
  - Returns `{ runId, status, accepted, message, summary }`
- `GET /api/ingestion/runs?limit=20`
  - List latest ingestion runs
- `GET /api/scheduler/stats`
  - Runtime scheduler/config diagnostics

### Diagnostics

- `GET /health`
  - Includes enabled source counts and missing config hints

## Notes

- SerpAPI adapter now lazy-loads SDK so imports/tests do not hard-fail before install.
- Dedup uses canonical fingerprint first (URL host/path), with fallback composite key.
