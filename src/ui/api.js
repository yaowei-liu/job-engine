async function parseJsonOrThrow(res, fallback) {
  if (res.ok) return res.json();
  const err = await res.json().catch(() => ({}));
  throw new Error(err.error || fallback || `Request failed (${res.status})`);
}

export async function fetchJobs(params) {
  const res = await fetch(`/jobs?${params.toString()}`);
  return parseJsonOrThrow(res, `Failed to load jobs (${res.status})`);
}

export async function fetchLatestRun() {
  const res = await fetch('/api/ingestion/runs?limit=1');
  if (!res.ok) return null;
  const data = await res.json();
  return data.items?.[0] || null;
}

export async function fetchRunProgress(runId) {
  const res = await fetch(`/api/ingestion/runs/${runId}/progress`);
  return parseJsonOrThrow(res, `Failed to load run progress (${res.status})`);
}

export async function fetchStageCount(params) {
  const p = new URLSearchParams(params);
  p.set('page', '1');
  p.set('pageSize', '1');
  const res = await fetch(`/jobs?${p.toString()}`);
  if (!res.ok) return 0;
  const data = await res.json();
  return data.meta?.total || 0;
}

export async function updateJobStatus(id, status) {
  const res = await fetch(`/jobs/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return parseJsonOrThrow(res, 'Failed to update status');
}

export async function fetchProvenance(id) {
  const res = await fetch(`/jobs/${id}/provenance`);
  return parseJsonOrThrow(res, `Failed to load provenance (${res.status})`);
}

export async function triggerIngestionRun(llmMode = 'auto') {
  const res = await fetch('/api/scheduler/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llmMode }),
  });
  return parseJsonOrThrow(res, 'Failed to run ingestion');
}

export async function triggerInboxCleanupRun(llmMode = 'auto') {
  const res = await fetch('/api/scheduler/cleanup-inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llmMode }),
  });
  return parseJsonOrThrow(res, 'Failed to cleanup inbox');
}
