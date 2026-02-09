const crypto = require('crypto');

function getDB() {
  return require('./db');
}

const pendingBatchByRun = new Map();

function stableHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj || {})).digest('hex');
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeFitPayload(payload = {}) {
  const fitLabel = ['high', 'medium', 'low'].includes(String(payload.fit_label || '').toLowerCase())
    ? String(payload.fit_label).toLowerCase()
    : 'low';
  const fitScore = Math.max(0, Math.min(100, parseInt(payload.fit_score || '0', 10) || 0));
  const confidence = Math.max(0, Math.min(1, Number(payload.confidence) || 0));
  const reasonCodes = Array.isArray(payload.reason_codes) ? payload.reason_codes.slice(0, 20).map((s) => String(s)) : [];

  return {
    fitLabel,
    fitScore,
    confidence,
    reasonCodes,
    missingMustHave: Array.isArray(payload.missing_must_have)
      ? payload.missing_must_have.slice(0, 20).map((s) => String(s))
      : [],
  };
}

function getApiKey() {
  return process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
}

function getBaseUrl() {
  const endpoint = process.env.LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  const idx = endpoint.indexOf('/chat/completions');
  if (idx >= 0) return endpoint.slice(0, idx);
  const batchIdx = endpoint.indexOf('/batches');
  if (batchIdx >= 0) return endpoint.slice(0, batchIdx);
  return 'https://api.openai.com/v1';
}

function buildPrompt({ job, profile }) {
  return {
    task: 'Classify job fit for candidate profile',
    rules: 'Return strict JSON only',
    profile,
    job: {
      title: job.title || '',
      company: job.company || '',
      location: job.location || '',
      description: (job.jd_text || '').slice(0, 7000),
    },
    output_schema: {
      fit_label: 'high|medium|low',
      fit_score: 'integer 0-100',
      confidence: 'float 0-1',
      reason_codes: ['short_code'],
      missing_must_have: ['skill'],
    },
  };
}

function buildChatRequestBody({ model, prompt }) {
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a strict JSON classifier for job fit. Output JSON only.' },
      { role: 'user', content: JSON.stringify(prompt) },
    ],
  };
}

async function getDailyUsage(now = new Date()) {
  const { dbGet } = getDB();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const row = await dbGet(
    `SELECT COALESCE(SUM(calls), 0) AS used
     FROM llm_usage
     WHERE created_at >= ? AND created_at < ?`,
    [start, end]
  );
  return row?.used || 0;
}

async function getRunUsage(runId) {
  if (!runId) return 0;
  const { dbGet } = getDB();
  const row = await dbGet(
    `SELECT COALESCE(SUM(calls), 0) AS used
     FROM llm_usage
     WHERE run_id = ?`,
    [runId]
  );
  return row?.used || 0;
}

async function recordUsage({ runId = null, calls = 0, tokensPrompt = 0, tokensCompletion = 0 } = {}) {
  const { dbRun } = getDB();
  if (!calls) return;
  await dbRun(
    `INSERT INTO llm_usage (run_id, calls, tokens_prompt, tokens_completion)
     VALUES (?, ?, ?, ?)`,
    [runId, calls, tokensPrompt, tokensCompletion]
  );
}

async function getCachedFit(cacheKey) {
  const { dbGet } = getDB();
  const row = await dbGet(
    `SELECT fit_label, fit_score, confidence, reason_codes_json, missing_must_have_json
     FROM llm_fit_cache
     WHERE cache_key = ?
     LIMIT 1`,
    [cacheKey]
  );
  if (!row) return null;
  return {
    fitLabel: row.fit_label || 'low',
    fitScore: row.fit_score || 0,
    confidence: row.confidence || 0,
    reasonCodes: parseJsonSafe(row.reason_codes_json) || [],
    missingMustHave: parseJsonSafe(row.missing_must_have_json) || [],
    cached: true,
  };
}

async function setCachedFit(cacheKey, payload) {
  const { dbRun } = getDB();
  await dbRun(
    `INSERT INTO llm_fit_cache (
      cache_key, fit_label, fit_score, confidence, reason_codes_json, missing_must_have_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(cache_key) DO UPDATE SET
      fit_label = excluded.fit_label,
      fit_score = excluded.fit_score,
      confidence = excluded.confidence,
      reason_codes_json = excluded.reason_codes_json,
      missing_must_have_json = excluded.missing_must_have_json,
      updated_at = CURRENT_TIMESTAMP`,
    [
      cacheKey,
      payload.fitLabel,
      payload.fitScore,
      payload.confidence,
      JSON.stringify(payload.reasonCodes || []),
      JSON.stringify(payload.missingMustHave || []),
    ]
  );
}

function buildCacheKey({ job, profile }) {
  const jobKey = stableHash({
    title: job.title || '',
    location: job.location || '',
    jdText: (job.jd_text || '').slice(0, 6000),
    source: job.source || '',
    url: job.url || '',
  });
  const profileKey = stableHash(profile || {});
  return `${jobKey}:${profileKey}`;
}

async function classifyWithLLM({ job, profile, runId = null, options = {} }) {
  const enabled = String(options.enabled || 'false').toLowerCase() === 'true';
  const apiKey = getApiKey();
  if (!enabled || !apiKey) {
    return { skipped: true, reason: 'disabled_or_missing_key' };
  }

  const cacheKey = buildCacheKey({ job, profile });
  const cached = await getCachedFit(cacheKey);
  if (cached) return { ...cached, cacheKey };

  const dailyCap = Math.max(1, parseInt(String(options.dailyCap || '120'), 10));
  const used = await getDailyUsage();
  if (used >= dailyCap) {
    return { skipped: true, reason: 'daily_cap_reached', cacheKey };
  }
  const maxPerRun = Math.max(1, parseInt(String(options.maxPerRun || '30'), 10));
  const runUsed = await getRunUsage(runId);
  if (runUsed >= maxPerRun) {
    return { skipped: true, reason: 'run_cap_reached', cacheKey };
  }

  const endpoint = options.endpoint || process.env.LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  const model = options.model || process.env.LLM_MODEL || 'gpt-4o-mini';
  const timeoutMs = Math.max(3000, parseInt(String(options.timeoutMs || '15000'), 10));
  const prompt = buildPrompt({ job, profile });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildChatRequestBody({ model, prompt })),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { skipped: true, reason: `llm_http_${res.status}`, cacheKey };
    }
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content || '{}';
    const parsed = parseJsonSafe(content) || {};
    const normalized = normalizeFitPayload(parsed);

    await setCachedFit(cacheKey, normalized);
    await recordUsage({
      runId,
      calls: 1,
      tokensPrompt: body?.usage?.prompt_tokens || 0,
      tokensCompletion: body?.usage?.completion_tokens || 0,
    });

    return { ...normalized, cacheKey, cached: false };
  } catch {
    return { skipped: true, reason: 'llm_request_failed', cacheKey };
  } finally {
    clearTimeout(timer);
  }
}

async function queueBatchClassification({ runId, jobId, job, profile, options = {} }) {
  const apiKey = getApiKey();
  if (!apiKey) return { skipped: true, reason: 'disabled_or_missing_key' };

  const cacheKey = buildCacheKey({ job, profile });
  const cached = await getCachedFit(cacheKey);
  if (cached) return { ...cached, cacheKey };

  const model = options.batchModel || options.model || process.env.LLM_MODEL || 'gpt-4o-mini';
  const customId = `run_${runId}_job_${jobId}_${stableHash({ cacheKey, t: Date.now() }).slice(0, 10)}`;
  const prompt = buildPrompt({ job, profile });
  const requestBody = buildChatRequestBody({ model, prompt });
  const { dbGet, dbRun } = getDB();

  const existing = await dbGet(
    `SELECT id, custom_id FROM llm_batch_items WHERE run_id = ? AND job_id = ? AND state = 'queued' LIMIT 1`,
    [runId, jobId]
  );
  if (!existing) {
    await dbRun(
      `INSERT INTO llm_batch_items (run_id, job_id, cache_key, custom_id, state, updated_at)
       VALUES (?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP)`,
      [runId, jobId, cacheKey, customId]
    );
  } else {
    return {
      skipped: true,
      reason: 'batch_queued',
      cacheKey,
      customId: existing.custom_id,
      batchQueued: true,
    };
  }

  const bucket = pendingBatchByRun.get(runId) || { model, items: [] };
  bucket.model = model;
  bucket.items.push({ customId, cacheKey, jobId, requestBody });
  pendingBatchByRun.set(runId, bucket);

  return {
    skipped: true,
    reason: 'batch_queued',
    cacheKey,
    customId,
    batchQueued: true,
  };
}

async function flushBatchForRun({ runId, options = {} }) {
  const apiKey = getApiKey();
  const { dbRun } = getDB();
  const bucket = pendingBatchByRun.get(runId);
  if (!bucket || !bucket.items.length) return null;
  if (!apiKey) return { error: 'missing_api_key', submitted: 0 };

  const baseUrl = getBaseUrl();
  const completionWindow = options.batchCompletionWindow || '24h';
  const lines = bucket.items.map((item) => JSON.stringify({
    custom_id: item.customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body: item.requestBody,
  }));
  const jsonl = `${lines.join('\n')}\n`;

  try {
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), `run-${runId}-llm-batch.jsonl`);

    const fileRes = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!fileRes.ok) throw new Error(`file_upload_${fileRes.status}`);
    const fileBody = await fileRes.json();
    const inputFileId = fileBody.id;

    const batchRes = await fetch(`${baseUrl}/batches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input_file_id: inputFileId,
        endpoint: '/v1/chat/completions',
        completion_window: completionWindow,
        metadata: { run_id: String(runId), source: 'job-engine' },
      }),
    });
    if (!batchRes.ok) throw new Error(`batch_create_${batchRes.status}`);
    const batchBody = await batchRes.json();
    const batchId = batchBody.id;

    await dbRun(
      `INSERT INTO llm_batches (run_id, batch_id, status, model, input_file_id, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [runId, batchId, batchBody.status || 'validating', bucket.model, inputFileId]
    );

    for (const item of bucket.items) {
      await dbRun(
        `UPDATE llm_batch_items
         SET batch_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE run_id = ? AND custom_id = ?`,
        [batchId, runId, item.customId]
      );
      await dbRun(
        `UPDATE job_queue
         SET llm_pending_batch_id = ?, llm_review_updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND llm_pending_custom_id = ?`,
        [batchId, item.jobId, item.customId]
      );
    }
    pendingBatchByRun.delete(runId);
    return { batchId, submitted: bucket.items.length };
  } catch (err) {
    for (const item of bucket.items) {
      await dbRun(
        `UPDATE llm_batch_items
         SET state = 'failed', error_text = ?, updated_at = CURRENT_TIMESTAMP
         WHERE run_id = ? AND custom_id = ?`,
        [err.message, runId, item.customId]
      );
    }
    pendingBatchByRun.delete(runId);
    return { error: err.message, submitted: 0 };
  }
}

async function applyBatchResultRow({ item, payload, runId, llmAdmitThreshold = 65 }) {
  const { dbRun } = getDB();
  const fit = normalizeFitPayload(payload);
  await setCachedFit(item.cache_key, fit);
  const admitted = fit.fitLabel === 'high' || fit.fitScore >= llmAdmitThreshold;
  const bucket = admitted ? 'high' : 'filtered';
  const nextStatus = admitted ? 'inbox' : 'filtered';

  await dbRun(
    `UPDATE job_queue
     SET fit_score = ?, fit_label = ?, fit_source = 'llm', fit_reason_codes = ?,
         quality_bucket = ?, rejected_by_quality = ?, llm_confidence = ?, llm_missing_must_have = ?,
         llm_review_state = 'completed', llm_pending_batch_id = NULL, llm_pending_custom_id = NULL,
         llm_review_error = NULL, llm_review_updated_at = CURRENT_TIMESTAMP,
         status = CASE WHEN status IN ('approved', 'applied', 'skipped') THEN status ELSE ? END,
         last_run_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      fit.fitScore,
      fit.fitLabel,
      JSON.stringify(fit.reasonCodes || []),
      bucket,
      admitted ? 0 : 1,
      fit.confidence,
      JSON.stringify(fit.missingMustHave || []),
      nextStatus,
      runId || null,
      item.job_id,
    ]
  );

  await dbRun(
    `INSERT INTO job_events (job_id, run_id, event_type, message, payload_json)
     VALUES (?, ?, 'llm_batch_completed', ?, ?)`,
    [
      item.job_id,
      runId || null,
      `Applied batch LLM fit (label=${fit.fitLabel}, score=${fit.fitScore})`,
      JSON.stringify({ fitLabel: fit.fitLabel, fitScore: fit.fitScore, admitted }),
    ]
  );
}

async function pollAndReconcileBatches({ options = {} } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return { checked: 0, completed: 0, failed: 0 };
  const baseUrl = getBaseUrl();
  const llmAdmitThreshold = Math.max(1, parseInt(String(options.llmAdmitThreshold || '65'), 10));
  const { dbAll, dbRun } = getDB();

  const active = await dbAll(
    `SELECT * FROM llm_batches
     WHERE status IN ('validating', 'in_progress', 'finalizing', 'submitted')
     ORDER BY id DESC
     LIMIT 30`
  );
  let completed = 0;
  let failed = 0;

  for (const row of active) {
    try {
      const res = await fetch(`${baseUrl}/batches/${row.batch_id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) continue;
      const batch = await res.json();

      await dbRun(
        `UPDATE llm_batches
         SET status = ?, output_file_id = ?, error_file_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE batch_id = ?`,
        [batch.status || row.status, batch.output_file_id || null, batch.error_file_id || null, row.batch_id]
      );

      if (batch.status === 'completed' && batch.output_file_id) {
        const outRes = await fetch(`${baseUrl}/files/${batch.output_file_id}/content`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const text = outRes.ok ? await outRes.text() : '';
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const items = await dbAll(`SELECT * FROM llm_batch_items WHERE batch_id = ?`, [row.batch_id]);
        const byCustomId = new Map(items.map((i) => [i.custom_id, i]));
        let tokensPrompt = 0;
        let tokensCompletion = 0;
        let calls = 0;

        for (const line of lines) {
          const parsed = parseJsonSafe(line);
          if (!parsed) continue;
          const customId = parsed.custom_id || '';
          const item = byCustomId.get(customId);
          if (!item) continue;

          const body = parsed.response?.body || {};
          const content = body?.choices?.[0]?.message?.content || '{}';
          const payload = parseJsonSafe(content);
          if (payload) {
            await applyBatchResultRow({
              item,
              payload,
              runId: row.run_id,
              llmAdmitThreshold,
            });
            await dbRun(
              `UPDATE llm_batch_items SET state = 'completed', error_text = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [item.id]
            );
            calls += 1;
            tokensPrompt += body?.usage?.prompt_tokens || 0;
            tokensCompletion += body?.usage?.completion_tokens || 0;
          } else {
            await dbRun(
              `UPDATE llm_batch_items SET state = 'failed', error_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              ['invalid_batch_response', item.id]
            );
          }
        }

        await dbRun(
          `UPDATE llm_batches
           SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE batch_id = ?`,
          [row.batch_id]
        );
        await recordUsage({ runId: row.run_id, calls, tokensPrompt, tokensCompletion });
        completed += 1;
      } else if (['failed', 'expired', 'cancelled'].includes(batch.status)) {
        await dbRun(
          `UPDATE llm_batches
           SET status = ?, error_text = COALESCE(?, error_text), failed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE batch_id = ?`,
          [batch.status, batch?.errors ? JSON.stringify(batch.errors) : null, row.batch_id]
        );
        await dbRun(
          `UPDATE llm_batch_items
           SET state = 'failed', error_text = ?, updated_at = CURRENT_TIMESTAMP
           WHERE batch_id = ? AND state = 'queued'`,
          [batch.status, row.batch_id]
        );
        await dbRun(
          `UPDATE job_queue
           SET llm_review_state = 'failed', llm_review_error = ?, llm_review_updated_at = CURRENT_TIMESTAMP
           WHERE llm_pending_batch_id = ?`,
          [batch.status, row.batch_id]
        );
        failed += 1;
      }
    } catch {
      // continue polling other batches
    }
  }

  return { checked: active.length, completed, failed };
}

module.exports = {
  buildCacheKey,
  classifyWithLLM,
  getDailyUsage,
  pollAndReconcileBatches,
  queueBatchClassification,
  flushBatchForRun,
};
