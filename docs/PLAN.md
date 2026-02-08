# Job Engine Plan (MVP)

## Goals
- Preference-based filtering + scoring
- 24h/7d freshness filter
- Manual approve/skip workflow
- Sync to personal dashboard

## Phases
**Phase 1 (MVP)**
- DB schema: `job_queue`, `preferences`
- Rule engine (configurable weights)
- One source adapter (Greenhouse)
- Web UI list + approve/skip
- Write-through to personal dashboard

**Phase 2**
- More sources (Lever/Ashby/Company pages)
- WhatsApp approvals/notifications

**Phase 3**
- Resume tailoring + semi-auto application
