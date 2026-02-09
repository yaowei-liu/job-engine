const crypto = require('crypto');
const { scoreJD } = require('./score');
const { extractYearsRequirement } = require('./jdExtract');

function getDB() {
  return require('./db');
}

function normalizeText(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeJob(job = {}) {
  const company = String(job.company || 'Unknown').trim();
  const title = String(job.title || '').trim();
  const location = String(job.location || '').trim();
  const postDate = String(job.post_date || '').trim();
  const url = String(job.url || '').trim();
  const source = String(job.source || 'unknown').trim().toLowerCase();
  const jdText = String(job.jd_text || '').trim();

  return {
    company,
    title,
    location: location || null,
    post_date: postDate || null,
    source,
    url: url || null,
    jd_text: jdText || null,
    is_bigtech: !!job.is_bigtech,
    meta: job.meta || null,
  };
}

function parseUrlParts(rawUrl = '') {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    const host = normalizeText(u.hostname).replace(/^www\./, '');
    const pathname = (u.pathname || '').replace(/\/+$/, '');
    if (!host || !pathname) return null;
    return `${host}${pathname}`;
  } catch {
    return null;
  }
}

function buildFingerprint(job = {}) {
  const normalized = normalizeJob(job);
  const urlKey = parseUrlParts(normalized.url);

  if (urlKey) {
    return {
      value: `url:${urlKey}`,
      reason: 'url',
    };
  }

  const companyKey = normalizeText(normalized.company);
  const titleKey = normalizeText(normalized.title);
  const locationKey = normalizeText(normalized.location);
  const dateBucket = (normalized.post_date || '').slice(0, 10);
  const composite = `${companyKey}|${titleKey}|${locationKey}|${dateBucket}`;

  return {
    value: `composite:${composite}`,
    reason: 'company+title+location+post_date',
  };
}

function buildSourceJobKey(job = {}) {
  const normalized = normalizeJob(job);
  const url = normalized.url || '';
  if (url) return `${normalized.source}:${url}`;
  return `${normalized.source}:${normalizeText(normalized.company)}|${normalizeText(normalized.title)}|${normalized.post_date || ''}`;
}

function payloadHash(job = {}) {
  return crypto.createHash('sha1').update(JSON.stringify(normalizeJob(job))).digest('hex');
}

async function createRun(triggerType = 'manual') {
  const { dbRun } = getDB();
  const result = await dbRun(
    `INSERT INTO ingestion_runs (trigger_type, status) VALUES (?, 'running')`,
    [triggerType]
  );
  return result.lastID;
}

async function finalizeRun(runId, status, summary, errorText = null) {
  const { dbRun } = getDB();
  await dbRun(
    `UPDATE ingestion_runs
     SET status = ?, summary_json = ?, error_text = ?, finished_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, JSON.stringify(summary || {}), errorText, runId]
  );
}

async function addJobEvent({ jobId, runId = null, eventType, message = '', payload = null }) {
  const { dbRun } = getDB();
  if (!jobId || !eventType) return;
  await dbRun(
    `INSERT INTO job_events (job_id, run_id, event_type, message, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
    [jobId, runId, eventType, message, payload ? JSON.stringify(payload) : null]
  );
}

async function ingestJob(job, runId) {
  const { dbGet, dbRun } = getDB();
  const normalized = normalizeJob(job);
  if (!normalized.company || !normalized.title) {
    return { skipped: true, reason: 'missing-company-or-title' };
  }

  const { score, tier, hits } = scoreJD(normalized.jd_text, normalized.post_date, normalized.title);
  const yearsReq = extractYearsRequirement(normalized.jd_text || '');
  const companyKey = normalizeText(normalized.company);
  const titleKey = normalizeText(normalized.title);
  const locationKey = normalizeText(normalized.location);
  const postDateKey = normalized.post_date || '';
  const fingerprint = buildFingerprint(normalized);
  const sourceKey = buildSourceJobKey(normalized);
  const hash = payloadHash(normalized);

  const existing = await dbGet(
    `SELECT id FROM job_queue WHERE canonical_fingerprint = ? LIMIT 1`,
    [fingerprint.value]
  );

  let jobId = null;
  let deduped = false;

  if (existing?.id) {
    deduped = true;
    jobId = existing.id;
    await dbRun(
      `UPDATE job_queue
       SET company = ?, title = ?, location = ?, post_date = ?, source = ?, url = ?, jd_text = ?, score = ?, tier = ?, status = COALESCE(status, 'inbox'),
           hits = ?, years_req = ?, is_bigtech = ?, company_key = ?, title_key = ?, location_key = ?, post_date_key = ?,
           canonical_fingerprint = ?, dedup_reason = ?, last_run_id = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        normalized.company,
        normalized.title,
        normalized.location,
        normalized.post_date,
        normalized.source,
        normalized.url,
        normalized.jd_text,
        score,
        tier,
        JSON.stringify(hits),
        yearsReq,
        normalized.is_bigtech ? 1 : 0,
        companyKey,
        titleKey,
        locationKey,
        postDateKey,
        fingerprint.value,
        fingerprint.reason,
        runId || null,
        jobId,
      ]
    );
  } else {
    const inserted = await dbRun(
      `INSERT INTO job_queue (
        company, title, location, post_date, source, url, jd_text, score, tier, status, hits, years_req,
        is_bigtech, company_key, title_key, location_key, post_date_key, canonical_fingerprint,
        first_seen_at, last_seen_at, last_run_id, dedup_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`,
      [
        normalized.company,
        normalized.title,
        normalized.location,
        normalized.post_date,
        normalized.source,
        normalized.url,
        normalized.jd_text,
        score,
        tier,
        JSON.stringify(hits),
        yearsReq,
        normalized.is_bigtech ? 1 : 0,
        companyKey,
        titleKey,
        locationKey,
        postDateKey,
        fingerprint.value,
        runId || null,
        fingerprint.reason,
      ]
    );
    jobId = inserted.lastID;
  }

  await dbRun(
    `INSERT INTO job_sources (job_id, run_id, source, source_job_key, raw_post_date, normalized_post_date, payload_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [jobId, runId || null, normalized.source, sourceKey, normalized.post_date, normalized.post_date, hash]
  );

  await addJobEvent({
    jobId,
    runId,
    eventType: deduped ? 'deduped' : 'ingested',
    message: deduped ? 'Matched existing job via canonical fingerprint' : 'Inserted as new job',
    payload: {
      fingerprint: fingerprint.value,
      dedupReason: fingerprint.reason,
      source: normalized.source,
      sourceJobKey: sourceKey,
    },
  });

  return {
    id: jobId,
    deduped,
    score,
    tier,
    hits,
    source: normalized.source,
    title: normalized.title,
  };
}

module.exports = {
  addJobEvent,
  buildFingerprint,
  createRun,
  finalizeRun,
  ingestJob,
  normalizeJob,
};
