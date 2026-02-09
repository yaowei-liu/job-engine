const crypto = require('crypto');

function getDB() {
  return require('./db');
}

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
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
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

  const prompt = {
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a strict JSON classifier for job fit. Output JSON only.' },
          { role: 'user', content: JSON.stringify(prompt) },
        ],
      }),
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

module.exports = {
  buildCacheKey,
  classifyWithLLM,
  getDailyUsage,
};
