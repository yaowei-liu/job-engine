# Architecture (MVP)

## Modules
- **Ingestion**: source adapters (Greenhouse/Lever/Ashby, manual LinkedIn capture)
- **Normalizer**: unify fields -> job_queue
- **Rule Engine**: keyword weights + freshness; tiers A/B
- **Workflow**: inbox -> approve/skip -> sync to personal dashboard

## Data Flow
1. Fetch JD -> normalize -> score
2. Save to `job_queue`
3. Approve/skip in UI
4. Approved jobs synced to `personal-dashboard` job_applications (via PD_DB_PATH)
