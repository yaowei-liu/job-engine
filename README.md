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

Primary config file: `config/sources.json`.
Fit profile file: `config/profile.json`.

Precedence:
- Environment variables override `config/sources.json`
- `config/sources.json` overrides built-in defaults

### Core sources

```bash
export GREENHOUSE_BOARDS="https://boards.greenhouse.io/company-a,https://boards.greenhouse.io/company-b"
export LEVER_BOARDS="https://jobs.lever.co/company-a"
export ASHBY_TARGETS="notion,https://jobs.ashbyhq.com/stripe"
export WORKDAY_TARGETS="https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite"

export SERPAPI_KEY="<your-key>"
export SERPAPI_QUERIES="software engineer toronto,backend engineer toronto"
export SERPAPI_LOCATION="Toronto, ON, Canada"
```

### Scheduler

```bash
export FETCH_INTERVAL_MIN=15
export RUN_ON_STARTUP=true
export SERPAPI_FETCH_INTERVAL_MIN=1440
export SERPAPI_RUN_ON_STARTUP=false
export SERPAPI_MONTHLY_QUERY_CAP=250
export SERPAPI_BUDGET_SAFETY_RESERVE=10
export SERPAPI_FRESHNESS_HOURS=24
export SERPAPI_ALLOW_UNKNOWN_POST_DATE=false
export SOURCE_FRESHNESS_HOURS=24
export ALLOW_UNKNOWN_POST_DATE=false
```

### Quality Gate + LLM Fit (optional)

```bash
export QUALITY_MIN_INBOX_SCORE=55
export QUALITY_BORDERLINE_MIN=35
export QUALITY_BORDERLINE_MAX=54
export QUALITY_LLM_ADMIT_THRESHOLD=65
export LLM_ENABLED=false
export LLM_DAILY_CAP=120
export LLM_MAX_PER_RUN=30
export LLM_MODEL="gpt-4o-mini"
export OPENAI_API_KEY="<optional>"
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
  - `filtered` jobs are hidden by default unless `includeFiltered=true`
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
- `POST /api/scheduler/run-serpapi`
  - Manually trigger SerpAPI-only run (budget-capped)
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

## Backlog

- Startup search expansion (future):
  - Add startup-focused source profile separate from big-tech targets.
  - Evaluate/add YC Jobs (`https://www.ycombinator.com/jobs`) ingestion adapter.
  - Evaluate/add Wellfound (`https://wellfound.com/`) ingestion adapter.
  - Add config toggle to run startup profile on its own cadence.
- LLM-assisted fit scoring (future):
  - Use an LLM to analyze each JD against personal background (skills, projects, experience).
  - Produce structured match signals (skill overlap, missing requirements, seniority fit).
  - Feed those signals into the existing scoring pipeline to adjust `score`/`tier`.
  - Add explanation output so fit changes are transparent in the review UI.
