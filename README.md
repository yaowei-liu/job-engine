# Job Engine

Personal job search engine for Jason.

## MVP Features
- **Multi-source ingestion**: Greenhouse boards + SerpAPI (Google Jobs)
- **Preference-based scoring**: Rule engine weights tech stack, seniority, etc.
- **24h/7d freshness**: Auto-refresh every 15 minutes
- **One-click approve/skip**: Web UI with instant feedback
- **Dashboard sync**: Auto-syncs approved jobs to personal dashboard

## Quick Start

```bash
cd job-engine

# Install deps
npm install

# Set target companies (optional)
export GREENHOUSE_BOARDS="https://boards.greenhouse.io/lever,https://boards.greenhouse.io/ashby"

# SerpAPI (Google Jobs)
export SERPAPI_KEY="<your_key>"
export SERPAPI_QUERIES="software engineer toronto,backend engineer toronto"
export SERPAPI_LOCATION="Toronto, ON, Canada"

# Run
npm run dev
```

## Endpoints

- **UI**: http://localhost:3030/
- **List jobs**: `GET /jobs?tier=A&status=inbox`
- **Ingest manually**: `POST /jobs/ingest`
- **Approve/Skip**: `POST /jobs/:id/status`
- **Trigger fetch**: `POST /api/scheduler/run`
- **Health**: `GET /health`

## Configuration

Edit `src/lib/rules.default.json` to adjust scoring weights.
Set `GREENHOUSE_BOARDS` and `SERPAPI_*` env vars to target sources.

## Architecture

See `docs/PLAN.md` and `docs/ARCHITECTURE.md`.
