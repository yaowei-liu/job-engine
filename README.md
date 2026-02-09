# Job Engine

Job Engine is a lightweight job aggregation service that pulls postings from multiple sources, scores them against your preferences, and provides a minimal UI to review and triage.

## Features
- **Multi-source ingestion**: Greenhouse, Lever, SerpAPI (Google Jobs)
- **Preference-based scoring**: rules-driven scoring for tech stack, seniority, etc.
- **Triage workflow**: approve / applied / skipped statuses
- **De-duplication**: avoids repeated jobs across runs
- **Dashboard sync**: optional webhook/DB sync on “applied”
- **Manual scan**: trigger fetch on-demand

## Quick Start
```bash
npm install

# Run locally
npm run dev
```

Open: `http://localhost:3030/`

## Configuration
Create a `.env` file (see `.env.example` if present):

```bash
PORT=3030
FETCH_INTERVAL_MIN=15
RUN_ON_STARTUP=true

# Greenhouse & Lever
GREENHOUSE_BOARDS="https://boards.greenhouse.io/yourcompany"
LEVER_BOARDS="https://jobs.lever.co/yourcompany"

# SerpAPI (Google Jobs)
SERPAPI_KEY="<your_key>"
SERPAPI_QUERIES="software engineer toronto,backend engineer toronto"
SERPAPI_LOCATION="Toronto, ON, Canada"
```

### Big Tech (optional)
```bash
BIGTECH_GREENHOUSE_BOARDS="https://boards.greenhouse.io/stripe,https://boards.greenhouse.io/uber"
BIGTECH_LEVER_BOARDS="https://jobs.lever.co/yourcompany"
BIGTECH_FETCH_INTERVAL_MIN=1440
RUN_ON_STARTUP_BIGTECH=false
```

## API Endpoints
- **UI**: `GET /`
- **List jobs**: `GET /jobs?tier=A&status=inbox&source=greenhouse&bigtech=true`
- **Ingest (manual)**: `POST /jobs/ingest`
- **Update status**: `POST /jobs/:id/status` (approved | applied | skipped)
- **Trigger scan**: `POST /api/scheduler/run`
- **Health**: `GET /health`

## Development
```bash
npm test
```

## License
MIT
