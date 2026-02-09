const crypto = require('crypto');
const { scoreJD } = require('./score');
const { extractYearsRequirement } = require('./jdExtract');
const { evaluateDeterministicFit } = require('./qualityGate');
const { classifyWithLLM, queueBatchClassification } = require('./llmFit');

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
  jobId = null,
} = {}) {
  const llmMode = String(qualityOptions?.llm?.mode || 'realtime').toLowerCase();
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
    llmEligible: !!detFit.needsLLM,
    llmAttempted: false,
    llmSkippedReason: null,
    llmQueued: false,
    llmNeedsQueueAfterUpsert: false,
    llmPendingCustomId: null,
  };

  if (detFit.needsLLM) {
    if (llmMode === 'batch') {
      if (!jobId) {
        return {
          ...finalFit,
          admittedToInbox: true,
          qualityBucket: 'pending_llm',
          llmQueued: true,
          llmNeedsQueueAfterUpsert: true,
          llmAttempted: true,
          llmSkippedReason: 'batch_deferred_until_job_id',
        };
      }

      const queued = await queueBatchClassification({
        runId,
        jobId,
        job: normalizedJob,
        profile,
        options: qualityOptions.llm || {},
      });

      if (!queued.skipped) {
        const llmAdmitThreshold = Math.max(1, parseInt(String(qualityOptions.llmAdmitThreshold || '65'), 10));
        const admittedByLLM = queued.fitLabel === 'high' || queued.fitScore >= llmAdmitThreshold;
        return {
          fitScore: queued.fitScore,
          fitLabel: queued.fitLabel,
          fitSource: queued.cached ? 'llm_cache' : 'llm',
          qualityBucket: admittedByLLM ? 'high' : 'filtered',
          admittedToInbox: admittedByLLM,
          reasonCodes: (detFit.reasonCodes || []).concat((queued.reasonCodes || []).map((r) => `llm:${r}`)),
          llmConfidence: queued.confidence,
          missingMustHave: queued.missingMustHave || [],
          llmUsed: true,
          llmEligible: true,
          llmAttempted: true,
          llmSkippedReason: null,
          llmQueued: false,
          llmNeedsQueueAfterUpsert: false,
          llmPendingCustomId: null,
        };
      }

      if (queued.reason !== 'batch_queued') {
        return {
          ...finalFit,
          llmQueued: false,
          llmNeedsQueueAfterUpsert: false,
          llmAttempted: true,
          llmSkippedReason: queued.reason || 'batch_queue_failed',
          llmPendingCustomId: null,
        };
      }

      return {
        ...finalFit,
        admittedToInbox: true,
        qualityBucket: 'pending_llm',
        llmQueued: true,
        llmNeedsQueueAfterUpsert: false,
        llmAttempted: true,
        llmSkippedReason: queued.reason || 'batch_queued',
        llmPendingCustomId: queued.customId || null,
      };
    }

    finalFit.llmAttempted = true;
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
        llmEligible: true,
        llmAttempted: true,
        llmSkippedReason: null,
      };
    } else {
      finalFit.reasonCodes = (detFit.reasonCodes || []).concat([`llm_skipped:${llm.reason}`]);
      finalFit.llmSkippedReason = llm.reason || 'unknown';
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
    jobId: null,
  });

  const admissionStatus = (finalFit.admittedToInbox || finalFit.llmQueued) ? 'inbox' : 'filtered';

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
           llm_review_state = ?, llm_pending_batch_id = ?, llm_pending_custom_id = ?, llm_review_updated_at = ?, llm_review_error = ?,
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
        finalFit.llmQueued ? 'pending' : (finalFit.llmUsed ? 'completed' : 'none'),
        null,
        finalFit.llmPendingCustomId,
        finalFit.llmQueued || finalFit.llmUsed ? new Date().toISOString() : null,
        finalFit.llmSkippedReason ? String(finalFit.llmSkippedReason).slice(0, 400) : null,
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
        fit_reason_codes, quality_bucket, rejected_by_quality, llm_confidence, llm_missing_must_have,
        llm_review_state, llm_pending_batch_id, llm_pending_custom_id, llm_review_updated_at, llm_review_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        finalFit.llmQueued ? 'pending' : (finalFit.llmUsed ? 'completed' : 'none'),
        null,
        finalFit.llmPendingCustomId,
        finalFit.llmQueued || finalFit.llmUsed ? new Date().toISOString() : null,
        finalFit.llmSkippedReason ? String(finalFit.llmSkippedReason).slice(0, 400) : null,
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

  if (finalFit.llmNeedsQueueAfterUpsert && jobId) {
    const queuedFit = await evaluateJobFit({
      normalizedJob: normalized,
      profile,
      qualityOptions,
      runId,
      jobId,
    });

    if (queuedFit.llmQueued) {
      await dbRun(
        `UPDATE job_queue
         SET llm_review_state = 'pending',
             llm_pending_custom_id = ?,
             llm_review_error = ?,
             llm_review_updated_at = CURRENT_TIMESTAMP,
             status = CASE WHEN status IN ('approved', 'applied', 'skipped') THEN status ELSE 'inbox' END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [queuedFit.llmPendingCustomId || null, queuedFit.llmSkippedReason || null, jobId]
      );
    } else if (queuedFit.llmUsed) {
      const nextStatus = queuedFit.admittedToInbox ? 'inbox' : 'filtered';
      await dbRun(
        `UPDATE job_queue
         SET fit_score = ?, fit_label = ?, fit_source = ?, fit_reason_codes = ?, quality_bucket = ?,
             rejected_by_quality = ?, llm_confidence = ?, llm_missing_must_have = ?, llm_review_state = 'completed',
             llm_pending_batch_id = NULL, llm_pending_custom_id = NULL, llm_review_error = NULL,
             llm_review_updated_at = CURRENT_TIMESTAMP,
             status = CASE WHEN status IN ('approved', 'applied', 'skipped') THEN status ELSE ? END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          queuedFit.fitScore,
          queuedFit.fitLabel,
          queuedFit.fitSource,
          JSON.stringify(queuedFit.reasonCodes || []),
          queuedFit.qualityBucket,
          queuedFit.admittedToInbox ? 0 : 1,
          queuedFit.llmConfidence,
          JSON.stringify(queuedFit.missingMustHave || []),
          nextStatus,
          jobId,
        ]
      );
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
      llmQueued: finalFit.llmQueued || false,
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
    llmEligible: finalFit.llmEligible,
    llmAttempted: finalFit.llmAttempted,
    llmSkippedReason: finalFit.llmSkippedReason,
    llmQueued: finalFit.llmQueued,
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
