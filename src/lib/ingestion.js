const crypto = require('crypto');
const { scoreJD } = require('./score');
const { extractYearsRequirement } = require('./jdExtract');
const { evaluateDeterministicFit } = require('./qualityGate');
const { classifyWithLLM } = require('./llmFit');

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

async function evaluateJobFit({
  normalizedJob = {},
  profile = {},
  qualityOptions = {},
  runId = null,
} = {}) {
  const detFit = evaluateDeterministicFit(normalizedJob, profile, qualityOptions);
  let finalFit = {
    fitScore: detFit.fitScore,
    fitLabel: detFit.fitLabel,
    fitSource: detFit.fitSource || 'rules',
    qualityBucket: detFit.qualityBucket,
    admittedToInbox: detFit.admittedToInbox,
    reasonCodes: detFit.reasonCodes || [],
    llmConfidence: null,
    missingMustHave: [],
    llmUsed: false,
  };

  if (detFit.needsLLM) {
    const llm = await classifyWithLLM({
      job: normalizedJob,
      profile,
      runId,
      options: qualityOptions.llm || {},
    });

    if (!llm.skipped) {
      const llmAdmitThreshold = Math.max(1, parseInt(String(qualityOptions.llmAdmitThreshold || '65'), 10));
      const admittedByLLM = llm.fitLabel === 'high' || llm.fitScore >= llmAdmitThreshold;
      finalFit = {
        fitScore: llm.fitScore,
        fitLabel: llm.fitLabel,
        fitSource: 'llm',
        qualityBucket: admittedByLLM ? 'high' : 'filtered',
        admittedToInbox: admittedByLLM,
        reasonCodes: (detFit.reasonCodes || []).concat((llm.reasonCodes || []).map((r) => `llm:${r}`)),
        llmConfidence: llm.confidence,
        missingMustHave: llm.missingMustHave || [],
        llmUsed: true,
      };
    } else {
      finalFit.reasonCodes = (detFit.reasonCodes || []).concat([`llm_skipped:${llm.reason}`]);
    }
  }

  return finalFit;
}

function isUniqueConstraintError(err) {
  return (
    !!err
    && String(err.code || '').toUpperCase() === 'SQLITE_CONSTRAINT'
    && /UNIQUE constraint failed/i.test(String(err.message || ''))
  );
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
  const qualityOptions = job.quality_options || {};
  const profile = job.profile || {};
  const finalFit = await evaluateJobFit({
    normalizedJob: normalized,
    profile,
    qualityOptions,
    runId,
  });

  const admissionStatus = finalFit.admittedToInbox ? 'inbox' : 'filtered';

  async function findExistingJobId() {
    const existing = await dbGet(
      `SELECT id
       FROM job_queue
       WHERE canonical_fingerprint = ?
          OR (company_key = ? AND title_key = ? AND location_key = ? AND post_date_key = ?)
          OR (company = ? AND title = ? AND COALESCE(url, '') = COALESCE(?, ''))
       LIMIT 1`,
      [
        fingerprint.value,
        companyKey,
        titleKey,
        locationKey,
        postDateKey,
        normalized.company,
        normalized.title,
        normalized.url,
      ]
    );
    return existing?.id || null;
  }

  async function updateExistingJob(existingJobId) {
    await dbRun(
      `UPDATE job_queue
       SET company = ?, title = ?, location = ?, post_date = ?, source = ?, url = ?, jd_text = ?, score = ?, tier = ?,
           status = CASE WHEN status IN ('approved', 'applied', 'skipped') THEN status ELSE ? END,
           hits = ?, years_req = ?, is_bigtech = ?, company_key = ?, title_key = ?, location_key = ?, post_date_key = ?,
           canonical_fingerprint = ?, dedup_reason = ?, last_run_id = ?, fit_score = ?, fit_label = ?, fit_source = ?,
           fit_reason_codes = ?, quality_bucket = ?, rejected_by_quality = ?, llm_confidence = ?, llm_missing_must_have = ?,
           last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
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
        admissionStatus,
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
        finalFit.fitScore,
        finalFit.fitLabel,
        finalFit.fitSource,
        JSON.stringify(finalFit.reasonCodes || []),
        finalFit.qualityBucket,
        finalFit.admittedToInbox ? 0 : 1,
        finalFit.llmConfidence,
        JSON.stringify(finalFit.missingMustHave || []),
        existingJobId,
      ]
    );
  }

  let jobId = await findExistingJobId();
  let deduped = !!jobId;

  if (deduped) {
    await updateExistingJob(jobId);
  } else {
    try {
      const inserted = await dbRun(
      `INSERT INTO job_queue (
        company, title, location, post_date, source, url, jd_text, score, tier, status, hits, years_req,
        is_bigtech, company_key, title_key, location_key, post_date_key, canonical_fingerprint,
        first_seen_at, last_seen_at, last_run_id, dedup_reason, fit_score, fit_label, fit_source,
        fit_reason_codes, quality_bucket, rejected_by_quality, llm_confidence, llm_missing_must_have
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        admissionStatus,
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
        finalFit.fitScore,
        finalFit.fitLabel,
        finalFit.fitSource,
        JSON.stringify(finalFit.reasonCodes || []),
        finalFit.qualityBucket,
        finalFit.admittedToInbox ? 0 : 1,
        finalFit.llmConfidence,
        JSON.stringify(finalFit.missingMustHave || []),
      ]
    );
      jobId = inserted.lastID;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      jobId = await findExistingJobId();
      if (!jobId) throw err;
      deduped = true;
      await updateExistingJob(jobId);
    }
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
      qualityBucket: finalFit.qualityBucket,
      admittedToInbox: finalFit.admittedToInbox,
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
    qualityBucket: finalFit.qualityBucket,
    admittedToInbox: finalFit.admittedToInbox,
    llmUsed: finalFit.llmUsed,
  };
}

module.exports = {
  addJobEvent,
  buildFingerprint,
  createRun,
  evaluateJobFit,
  finalizeRun,
  ingestJob,
  normalizeJob,
};
