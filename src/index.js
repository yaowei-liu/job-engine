require('dotenv').config();

const express = require('express');
const path = require('path');
const { initDB, dbAll, dbGet, dbRun } = require('./lib/db');
const jobsRouter = require('./routes/jobs');
const { fetchAll: fetchGreenhouse, DEFAULT_BOARDS: GH_BOARDS } = require('./lib/sources/greenhouse');
const { fetchAll: fetchLever, DEFAULT_BOARDS: LEVER_BOARDS } = require('./lib/sources/lever');
const { fetchAllWithStats: fetchSerpWithStats } = require('./lib/sources/serpapi');
const { fetchAll: fetchAmazon } = require('./lib/sources/amazon');
const { fetchAll: fetchAshby, DEFAULT_TARGETS: ASHBY_DEFAULT_TARGETS } = require('./lib/sources/ashby');
const { fetchAll: fetchWorkday, DEFAULT_TARGETS: WORKDAY_DEFAULT_TARGETS } = require('./lib/sources/workday');
const { loadSearchConfig, buildQueriesFromConfig } = require('./lib/searchConfig');
const {
  loadSourcesConfig,
  getListSetting,
  getIntSetting,
  getBoolSetting,
  getStringSetting,
} = require('./lib/sourcesConfig');
const { filterJobsByFreshness } = require('./lib/freshness');
const { getSerpApiRunBudget, recordUsage } = require('./lib/serpapiBudget');
const { addJobEvent, createRun, evaluateJobFit, finalizeRun, ingestJob, normalizeJob } = require('./lib/ingestion');
const { pollAndReconcileBatches, flushBatchForRun } = require('./lib/llmFit');
const { evaluateDeterministicFit } = require('./lib/qualityGate');
const { loadProfileConfig } = require('./lib/profileConfig');

const app = express();
app.use(express.json());

const sourcesCfg = loadSourcesConfig();
const coreCfg = sourcesCfg.core || {};
const serpapiCfg = sourcesCfg.serpapi || {};
const freshnessCfg = sourcesCfg.freshness || {};
const schedulerCfg = sourcesCfg.scheduler || {};
const bigTechCfg = sourcesCfg.bigtech || {};
const qualityCfg = sourcesCfg.quality || {};
const llmCfg = sourcesCfg.llm || {};
const profile = loadProfileConfig();

const TARGET_BOARDS = getListSetting(process.env.GREENHOUSE_BOARDS, coreCfg.greenhouse_boards, GH_BOARDS);
const LEVER_TARGETS = getListSetting(process.env.LEVER_BOARDS, coreCfg.lever_boards, LEVER_BOARDS);
const ASHBY_TARGETS = getListSetting(process.env.ASHBY_TARGETS, coreCfg.ashby_targets, ASHBY_DEFAULT_TARGETS);
const WORKDAY_TARGETS = getListSetting(process.env.WORKDAY_TARGETS, coreCfg.workday_targets, WORKDAY_DEFAULT_TARGETS);

const searchCfg = loadSearchConfig();
const SERP_QUERIES = (buildQueriesFromConfig(searchCfg) || [])
  .concat(getListSetting(process.env.SERPAPI_QUERIES, serpapiCfg.queries, []))
  .filter(Boolean);

const SERP_LOCATION = getStringSetting(process.env.SERPAPI_LOCATION, serpapiCfg.location, '').trim();
const SERP_FRESHNESS_HOURS = getIntSetting(process.env.SERPAPI_FRESHNESS_HOURS, freshnessCfg.serpapi_hours, 24);
const SERP_ALLOW_UNKNOWN_DATE = getBoolSetting(process.env.SERPAPI_ALLOW_UNKNOWN_POST_DATE, freshnessCfg.serpapi_allow_unknown_post_date, false);
const SOURCE_FRESHNESS_HOURS = getIntSetting(process.env.SOURCE_FRESHNESS_HOURS, freshnessCfg.source_hours, 24);
const SOURCE_ALLOW_UNKNOWN_DATE = getBoolSetting(process.env.ALLOW_UNKNOWN_POST_DATE, freshnessCfg.allow_unknown_post_date, false);
const FETCH_INTERVAL_MIN = getIntSetting(process.env.FETCH_INTERVAL_MIN, schedulerCfg.fetch_interval_min, 15);
const RUN_ON_STARTUP = getBoolSetting(process.env.RUN_ON_STARTUP, schedulerCfg.run_on_startup, true);
const SERPAPI_FETCH_INTERVAL_MIN = getIntSetting(process.env.SERPAPI_FETCH_INTERVAL_MIN, serpapiCfg.fetch_interval_min, 1440);
const SERPAPI_RUN_ON_STARTUP = getBoolSetting(process.env.SERPAPI_RUN_ON_STARTUP, serpapiCfg.run_on_startup, false);
const SERPAPI_MONTHLY_QUERY_CAP = getIntSetting(process.env.SERPAPI_MONTHLY_QUERY_CAP, serpapiCfg.monthly_query_cap, 250);
const SERPAPI_BUDGET_SAFETY_RESERVE = getIntSetting(process.env.SERPAPI_BUDGET_SAFETY_RESERVE, serpapiCfg.budget_safety_reserve, 10);
const SERPAPI_QUERY_CONCURRENCY = getIntSetting(process.env.SERPAPI_QUERY_CONCURRENCY, serpapiCfg.query_concurrency, 3);

const BIGTECH_LEVER_BOARDS = getListSetting(process.env.BIGTECH_LEVER_BOARDS, bigTechCfg.lever_boards, []);
const BIGTECH_GREENHOUSE_BOARDS = getListSetting(process.env.BIGTECH_GREENHOUSE_BOARDS, bigTechCfg.greenhouse_boards, []);
const BIGTECH_AMAZON_QUERIES = getListSetting(
  process.env.BIGTECH_AMAZON_QUERIES,
  bigTechCfg.amazon_queries,
  ['software engineer', 'backend engineer', 'full stack', 'entry level', 'new grad', 'early career']
);
const BIGTECH_AMAZON_LOCATIONS = getListSetting(
  process.env.BIGTECH_AMAZON_LOCATIONS,
  bigTechCfg.amazon_locations,
  ['Toronto, ON, Canada', 'Canada', 'Remote']
);
const BIGTECH_FETCH_INTERVAL_MIN = getIntSetting(process.env.BIGTECH_FETCH_INTERVAL_MIN, bigTechCfg.fetch_interval_min, 1440);
const RUN_ON_STARTUP_BIGTECH = getBoolSetting(process.env.RUN_ON_STARTUP_BIGTECH, bigTechCfg.run_on_startup, true);
const QUALITY_MIN_INBOX_SCORE = getIntSetting(process.env.QUALITY_MIN_INBOX_SCORE, qualityCfg.min_inbox_score, 55);
const QUALITY_BORDERLINE_MIN = getIntSetting(process.env.QUALITY_BORDERLINE_MIN, qualityCfg.borderline_min, 35);
const QUALITY_BORDERLINE_MAX = getIntSetting(process.env.QUALITY_BORDERLINE_MAX, qualityCfg.borderline_max, 54);
const QUALITY_LLM_ADMIT_THRESHOLD = getIntSetting(process.env.QUALITY_LLM_ADMIT_THRESHOLD, qualityCfg.llm_admit_threshold, 65);
const QUALITY_ALLOW_UNKNOWN_LOCATION = getBoolSetting(process.env.QUALITY_ALLOW_UNKNOWN_LOCATION, qualityCfg.allow_unknown_location, false);
const LLM_ENABLED = getBoolSetting(process.env.LLM_ENABLED, llmCfg.enabled, false);
const LLM_DAILY_CAP = getIntSetting(process.env.LLM_DAILY_CAP, llmCfg.daily_cap, 120);
const LLM_MAX_PER_RUN = getIntSetting(process.env.LLM_MAX_PER_RUN, llmCfg.max_per_run, 30);
const LLM_TIMEOUT_MS = getIntSetting(process.env.LLM_TIMEOUT_MS, llmCfg.timeout_ms, 15000);
const LLM_MODEL = getStringSetting(process.env.LLM_MODEL, llmCfg.model, 'gpt-4o-mini');
const LLM_BATCH_ENABLED = getBoolSetting(process.env.LLM_BATCH_ENABLED, llmCfg.batch_enabled, true);
const LLM_BATCH_THRESHOLD = getIntSetting(process.env.LLM_BATCH_THRESHOLD, llmCfg.batch_threshold, 20);
const LLM_BATCH_REALTIME_FALLBACK_COUNT = getIntSetting(
  process.env.LLM_BATCH_REALTIME_FALLBACK_COUNT,
  llmCfg.batch_realtime_fallback_count,
  5
);
const LLM_BATCH_POLL_INTERVAL_SEC = getIntSetting(process.env.LLM_BATCH_POLL_INTERVAL_SEC, llmCfg.batch_poll_interval_sec, 30);
const LLM_BATCH_MODEL = getStringSetting(process.env.LLM_BATCH_MODEL, llmCfg.batch_model, 'gpt-4o-mini');
const LLM_BATCH_COMPLETION_WINDOW = getStringSetting(process.env.LLM_BATCH_COMPLETION_WINDOW, llmCfg.batch_completion_window, '24h');

function buildQualityOptionsForRun(llmMode = 'auto') {
  return {
    minInboxScore: QUALITY_MIN_INBOX_SCORE,
    borderlineMin: QUALITY_BORDERLINE_MIN,
    borderlineMax: QUALITY_BORDERLINE_MAX,
    llmAdmitThreshold: QUALITY_LLM_ADMIT_THRESHOLD,
    allowUnknownLocation: QUALITY_ALLOW_UNKNOWN_LOCATION,
    llm: {
      enabled: String(LLM_ENABLED),
      dailyCap: LLM_DAILY_CAP,
      maxPerRun: LLM_MAX_PER_RUN,
      timeoutMs: LLM_TIMEOUT_MS,
      model: LLM_MODEL,
      mode: llmMode,
      batchEnabled: LLM_BATCH_ENABLED,
      batchThreshold: LLM_BATCH_THRESHOLD,
      batchRealtimeFallbackCount: LLM_BATCH_REALTIME_FALLBACK_COUNT,
      batchModel: LLM_BATCH_MODEL,
      batchCompletionWindow: LLM_BATCH_COMPLETION_WINDOW,
    },
  };
}

function clampLlmMode(value = 'auto') {
  const mode = String(value || 'auto').toLowerCase();
  if (['auto', 'realtime', 'batch'].includes(mode)) return mode;
  return 'auto';
}

function assignLlmModes(jobs = [], qualityOptions = {}, llmMode = 'auto') {
  const mode = clampLlmMode(llmMode);
  if (!jobs.length) return [];
  const out = jobs.map((job) => ({ ...job, __llm_mode: mode === 'auto' ? 'realtime' : mode }));
  if (mode !== 'auto') return out;
  const llmEnabled = String(qualityOptions?.llm?.enabled || 'false').toLowerCase() === 'true';
  const batchEnabled = !!qualityOptions?.llm?.batchEnabled;
  if (!llmEnabled || !batchEnabled) return out;

  const threshold = Math.max(1, parseInt(String(qualityOptions?.llm?.batchThreshold || 20), 10));
  const realtimeFallback = Math.max(0, parseInt(String(qualityOptions?.llm?.batchRealtimeFallbackCount || 5), 10));
  const borderlineIndexes = [];
  for (let i = 0; i < out.length; i += 1) {
    const fit = evaluateDeterministicFit(normalizeJob(out[i]), profile, qualityOptions);
    if (fit.needsLLM) borderlineIndexes.push(i);
  }
  if (borderlineIndexes.length < threshold) return out;
  borderlineIndexes.forEach((idx, pos) => {
    out[idx].__llm_mode = pos < realtimeFallback ? 'realtime' : 'batch';
  });
  return out;
}

function isTorontoOrRemote(location) {
  const loc = (location || '').toLowerCase();
  return (
    loc.includes('toronto') ||
    loc.includes('gta') ||
    loc.includes('ontario') ||
    loc.includes('canada') ||
    loc.includes('remote') ||
    loc.includes('hybrid')
  );
}

function missingSourceConfig() {
  const missing = [];
  if (!TARGET_BOARDS.length && !LEVER_TARGETS.length && !SERP_QUERIES.length && !ASHBY_TARGETS.length && !WORKDAY_TARGETS.length) {
    missing.push('No core source targets configured (GREENHOUSE_BOARDS / LEVER_BOARDS / ASHBY_TARGETS / WORKDAY_TARGETS / SERPAPI_QUERIES).');
  }
  if (SERP_QUERIES.length && !process.env.SERPAPI_KEY) {
    missing.push('SERPAPI_KEY is missing while SERPAPI_QUERIES are configured.');
  }
  return missing;
}

function applySourceFreshness(jobs, { source, hours, allowUnknownDate }) {
  const filtered = filterJobsByFreshness(jobs, { hours, allowUnknownDate });
  return {
    jobs: filtered.jobs,
    meta: {
      freshness: {
        source,
        ...filtered.stats,
      },
    },
  };
}

let isFetching = false;
let isBigTechFetching = false;
let isSerpFetching = false;
let isCleanupRunning = false;
const runProgress = new Map();
const RUN_PROGRESS_TTL_MS = 5 * 60 * 1000;

function initLlmProgress() {
  return {
    eligible: 0,
    attempted: 0,
    completed: 0,
    skipped: 0,
    inFlight: 0,
    percent: 0,
  };
}

function normalizeLlmProgress(input = {}) {
  const eligible = Math.max(0, Number(input.eligible) || 0);
  const attempted = Math.max(0, Number(input.attempted) || 0);
  const completed = Math.max(0, Number(input.completed) || 0);
  const skipped = Math.max(0, Number(input.skipped) || 0);
  const resolved = completed + skipped;
  const inFlight = Math.max(0, attempted - resolved);
  const percent = eligible > 0 ? Math.min(100, Math.round((resolved / eligible) * 100)) : 0;

  return {
    eligible,
    attempted,
    completed,
    skipped,
    inFlight,
    percent,
  };
}

function setRunProgress(runId, values = {}) {
  const current = runProgress.get(runId) || { runId };
  const merged = { ...current, ...values };
  merged.llm = normalizeLlmProgress(merged.llm || {});
  merged.updatedAt = new Date().toISOString();
  runProgress.set(runId, merged);
}

function bootstrapRunProgress(runId, { trigger, label, summary }) {
  setRunProgress(runId, {
    runId,
    trigger,
    label,
    status: 'running',
    totals: { ...(summary?.totals || {}) },
    quality: { ...(summary?.quality || {}) },
    llm: { ...(summary?.llm || initLlmProgress()) },
    startedAt: summary?.startedAt || new Date().toISOString(),
    finishedAt: null,
  });
}

function syncRunProgress(runId, summary, status = 'running') {
  if (!runProgress.has(runId)) return;
  setRunProgress(runId, {
    status,
    totals: { ...(summary?.totals || {}) },
    quality: { ...(summary?.quality || {}) },
    llm: { ...(summary?.llm || initLlmProgress()) },
    finishedAt: summary?.finishedAt || null,
  });
}

function pruneRunProgress() {
  const now = Date.now();
  for (const [runId, progress] of runProgress.entries()) {
    const isRunning = progress.status === 'running';
    const updatedAtMs = Date.parse(progress.updatedAt || progress.finishedAt || progress.startedAt || '');
    if (!isRunning && Number.isFinite(updatedAtMs) && now - updatedAtMs > RUN_PROGRESS_TTL_MS) {
      runProgress.delete(runId);
    }
  }
}

setInterval(pruneRunProgress, 60 * 1000).unref();

async function runPipeline({ triggerType, label, sourceTasks, transform = (jobs) => jobs, qualityOptions = {}, llmMode = 'auto' }) {
  const runId = await createRun(triggerType);
  const start = Date.now();
  const runQualityOptions = qualityOptions || {};
  const qualitySummary = {
    admittedToInbox: 0,
    filteredOut: 0,
    llmUsed: 0,
  };

  const summary = {
    runId,
    trigger: triggerType,
    label,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
    totals: {
      fetched: 0,
      inserted: 0,
      deduped: 0,
      failed: 0,
      skipped: 0,
    },
    quality: qualitySummary,
    llm: initLlmProgress(),
    sources: {},
    errors: [],
  };
  bootstrapRunProgress(runId, { trigger: triggerType, label, summary });

  try {
    const sourceResults = await Promise.all(
      sourceTasks.map(async (task) => {
        try {
          const payload = await task.fetch(runId);
          const jobs = Array.isArray(payload) ? payload : (Array.isArray(payload?.jobs) ? payload.jobs : []);
          const meta = Array.isArray(payload) ? null : (payload?.meta || null);
          return { source: task.source, jobs, meta, error: null };
        } catch (err) {
          return { source: task.source, jobs: [], meta: null, error: err.message };
        }
      })
    );

    for (const r of sourceResults) {
      summary.sources[r.source] = {
        fetched: r.jobs.length,
        inserted: 0,
        deduped: 0,
        failed: 0,
        error: r.error,
        ...(r.meta ? { meta: r.meta } : {}),
      };
      summary.totals.fetched += r.jobs.length;
      if (r.error) {
        summary.errors.push(`${r.source}: ${r.error}`);
      }
    }
    syncRunProgress(runId, summary, 'running');

    const jobs = assignLlmModes(transform(sourceResults.flatMap((r) => r.jobs)), qualityOptions, llmMode);

    for (const job of jobs) {
      const source = (job.source || 'unknown').toLowerCase();
      if (!summary.sources[source]) {
        summary.sources[source] = { fetched: 0, inserted: 0, deduped: 0, failed: 0, error: null };
      }

      try {
        const result = await ingestJob({
          ...job,
          profile,
          quality_options: {
            ...runQualityOptions,
            llm: {
              ...(runQualityOptions.llm || {}),
              mode: job.__llm_mode || runQualityOptions?.llm?.mode || 'auto',
            },
          },
        }, runId);
        if (result.skipped) {
          summary.totals.skipped += 1;
          syncRunProgress(runId, summary, 'running');
          continue;
        }
        if (result.admittedToInbox) qualitySummary.admittedToInbox += 1;
        else qualitySummary.filteredOut += 1;
        if (result.llmUsed) qualitySummary.llmUsed += 1;
        if (result.llmEligible) {
          summary.llm.eligible += 1;
          if (result.llmAttempted) summary.llm.attempted += 1;
          if (result.llmUsed) summary.llm.completed += 1;
          else if (result.llmQueued) summary.llm.batchQueued = (summary.llm.batchQueued || 0) + 1;
          else summary.llm.skipped += 1;
        }
        if (result.deduped) {
          summary.totals.deduped += 1;
          summary.sources[source].deduped += 1;
        } else {
          summary.totals.inserted += 1;
          summary.sources[source].inserted += 1;
        }
        syncRunProgress(runId, summary, 'running');
      } catch (err) {
        summary.totals.failed += 1;
        summary.sources[source].failed += 1;
        summary.errors.push(`${source}: ${err.message}`);
        syncRunProgress(runId, summary, 'running');
      }
    }

    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - start;

    const batchFlush = await flushBatchForRun({ runId, options: runQualityOptions.llm || {} });
    if (batchFlush?.batchId) {
      summary.llm.batchSubmitted = batchFlush.submitted || 0;
      summary.llm.batchId = batchFlush.batchId;
    } else if (batchFlush?.error) {
      summary.errors.push(`llm_batch: ${batchFlush.error}`);
    }

    const status = summary.errors.length ? (summary.totals.inserted || summary.totals.deduped ? 'partial' : 'failed') : 'success';
    await finalizeRun(runId, status, summary, summary.errors.join(' | ') || null);
    syncRunProgress(runId, summary, status);

    return {
      runId,
      status,
      accepted: true,
      message: `Run finished with status=${status}`,
      summary,
    };
  } catch (err) {
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - start;
    summary.errors.push(err.message);

    await finalizeRun(runId, 'failed', summary, err.message);
    syncRunProgress(runId, summary, 'failed');
    return {
      runId,
      status: 'failed',
      accepted: true,
      message: err.message,
      summary,
    };
  }
}

async function runFetcher(triggerType = 'manual', opts = {}) {
  if (isFetching) {
    return {
      accepted: false,
      status: 'running',
      message: 'Scheduler run already in progress',
    };
  }

  const llmMode = clampLlmMode(opts.llmMode || 'auto');
  isFetching = true;
  try {
    const response = await runPipeline({
      triggerType,
      label: 'core',
      qualityOptions: buildQualityOptionsForRun(llmMode),
      llmMode,
      sourceTasks: [
        {
          source: 'greenhouse',
          fetch: () => (TARGET_BOARDS.length ? fetchGreenhouse(TARGET_BOARDS) : Promise.resolve([])),
        },
        {
          source: 'lever',
          fetch: () => (LEVER_TARGETS.length ? fetchLever(LEVER_TARGETS) : Promise.resolve([])),
        },
        {
          source: 'ashby',
          fetch: async () => {
            if (!ASHBY_TARGETS.length) return [];
            const jobs = await fetchAshby(ASHBY_TARGETS);
            return applySourceFreshness(jobs, {
              source: 'ashby',
              hours: SOURCE_FRESHNESS_HOURS,
              allowUnknownDate: SOURCE_ALLOW_UNKNOWN_DATE,
            });
          },
        },
        {
          source: 'workday',
          fetch: async () => {
            if (!WORKDAY_TARGETS.length) return [];
            const jobs = await fetchWorkday(WORKDAY_TARGETS);
            return applySourceFreshness(jobs, {
              source: 'workday',
              hours: SOURCE_FRESHNESS_HOURS,
              allowUnknownDate: SOURCE_ALLOW_UNKNOWN_DATE,
            });
          },
        },
      ],
      transform: (jobs) => jobs.map((j) => ({ ...j, is_bigtech: false })),
    });

    console.log(`[Scheduler] ${response.message}. runId=${response.runId || 'n/a'}`);
    return response;
  } finally {
    isFetching = false;
  }
}

async function runSerpFetcher(triggerType = 'scheduler_serpapi', opts = {}) {
  if (isSerpFetching) {
    return {
      accepted: false,
      status: 'running',
      message: 'SerpAPI run already in progress',
    };
  }

  const llmMode = clampLlmMode(opts.llmMode || 'auto');
  isSerpFetching = true;
  try {
    const serpBudget = SERP_QUERIES.length
      ? await getSerpApiRunBudget({
        intervalMinutes: SERPAPI_FETCH_INTERVAL_MIN,
        monthlyCap: SERPAPI_MONTHLY_QUERY_CAP,
        reserve: SERPAPI_BUDGET_SAFETY_RESERVE,
      })
      : null;
    const serpPerRunLimit = Math.max(0, serpBudget?.perRunLimit || 0);
    const serpQueriesForRun = SERP_QUERIES.slice(0, serpPerRunLimit);

    const response = await runPipeline({
      triggerType,
      label: 'serpapi',
      qualityOptions: buildQualityOptionsForRun(llmMode),
      llmMode,
      sourceTasks: [
        {
          source: 'serpapi',
          fetch: async (runId) => {
            if (!SERP_QUERIES.length || !process.env.SERPAPI_KEY) {
              return {
                jobs: [],
                meta: {
                  budget: {
                    ...(serpBudget || {}),
                    executedQueries: 0,
                    reason: !process.env.SERPAPI_KEY ? 'missing_api_key' : 'no_queries',
                  },
                },
              };
            }

            if (!serpQueriesForRun.length) {
              return {
                jobs: [],
                meta: {
                  budget: {
                    ...serpBudget,
                    executedQueries: 0,
                    reason: 'budget_exhausted_or_reserved',
                  },
                },
              };
            }

            const serpResult = await fetchSerpWithStats(serpQueriesForRun, SERP_LOCATION, {
              concurrency: SERPAPI_QUERY_CONCURRENCY,
            });
            await recordUsage({
              runId,
              queriesUsed: serpResult.stats?.attempted || 0,
              notes: `queries=${serpResult.stats?.attempted || 0}`,
            });

            const filtered = applySourceFreshness(serpResult.jobs, {
              source: 'serpapi',
              hours: SERP_FRESHNESS_HOURS,
              allowUnknownDate: SERP_ALLOW_UNKNOWN_DATE,
            });

            return {
              jobs: filtered.jobs,
              meta: {
                ...filtered.meta,
                search: serpResult.stats,
                budget: {
                  ...serpBudget,
                  executedQueries: serpResult.stats?.attempted || 0,
                  configuredQueries: SERP_QUERIES.length,
                },
              },
            };
          },
        },
      ],
      transform: (jobs) => jobs.map((j) => ({ ...j, is_bigtech: false })),
    });

    console.log(`[SerpAPI] ${response.message}. runId=${response.runId || 'n/a'}`);
    return response;
  } finally {
    isSerpFetching = false;
  }
}

async function runBigTechFetcher(triggerType = 'scheduler_bigtech', opts = {}) {
  if (isBigTechFetching) {
    return {
      accepted: false,
      status: 'running',
      message: 'Big tech run already in progress',
    };
  }

  const llmMode = clampLlmMode(opts.llmMode || 'auto');
  isBigTechFetching = true;
  try {
    const response = await runPipeline({
      triggerType,
      label: 'bigtech',
      qualityOptions: buildQualityOptionsForRun(llmMode),
      llmMode,
      sourceTasks: [
        {
          source: 'greenhouse',
          fetch: () => (BIGTECH_GREENHOUSE_BOARDS.length ? fetchGreenhouse(BIGTECH_GREENHOUSE_BOARDS) : Promise.resolve([])),
        },
        {
          source: 'lever',
          fetch: () => (BIGTECH_LEVER_BOARDS.length ? fetchLever(BIGTECH_LEVER_BOARDS) : Promise.resolve([])),
        },
        {
          source: 'amazon',
          fetch: () => fetchAmazon({ baseQueries: BIGTECH_AMAZON_QUERIES, locQueries: BIGTECH_AMAZON_LOCATIONS }),
        },
      ],
      transform: (jobs) => jobs
        .filter((j) => isTorontoOrRemote(j.location) || j.meta?.is_virtual)
        .map((j) => ({ ...j, is_bigtech: true })),
    });

    console.log(`[BigTech] ${response.message}. runId=${response.runId || 'n/a'}`);
    return response;
  } finally {
    isBigTechFetching = false;
  }
}

async function runInboxCleanup(triggerType = 'manual_cleanup', opts = {}) {
  if (isCleanupRunning) {
    return {
      accepted: false,
      status: 'running',
      message: 'Inbox cleanup already in progress',
    };
  }

  isCleanupRunning = true;
  const runId = await createRun(triggerType);
  const start = Date.now();
  const llmMode = clampLlmMode(opts.llmMode || 'auto');
  const qualityOptions = buildQualityOptionsForRun(llmMode);
  const summary = {
    runId,
    trigger: triggerType,
    label: 'cleanup_inbox',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
    totals: {
      fetched: 0,
      inserted: 0,
      deduped: 0,
      failed: 0,
      skipped: 0,
      reevaluated: 0,
      kept: 0,
      filtered: 0,
    },
    quality: {
      admittedToInbox: 0,
      filteredOut: 0,
      llmUsed: 0,
    },
    llm: initLlmProgress(),
    sources: {
      cleanup_inbox: {
        fetched: 0,
        inserted: 0,
        deduped: 0,
        failed: 0,
        error: null,
      },
    },
    errors: [],
  };
  bootstrapRunProgress(runId, { trigger: triggerType, label: 'cleanup_inbox', summary });

  try {
    const rows = await dbAll(
      `SELECT id, company, title, location, post_date, source, url, jd_text, is_bigtech
       FROM job_queue
       WHERE status = 'inbox'
       ORDER BY id DESC`
    );
    summary.totals.fetched = rows.length;
    summary.sources.cleanup_inbox.fetched = rows.length;
    syncRunProgress(runId, summary, 'running');

    const withMode = assignLlmModes(rows.map((r) => ({ ...r })), qualityOptions, llmMode);
    for (const row of withMode) {
      try {
        const normalized = normalizeJob({
          company: row.company,
          title: row.title,
          location: row.location,
          post_date: row.post_date,
          source: row.source,
          url: row.url,
          jd_text: row.jd_text,
          is_bigtech: !!row.is_bigtech,
        });

        const fit = await evaluateJobFit({
          normalizedJob: normalized,
          profile,
          qualityOptions: {
            ...qualityOptions,
            llm: {
              ...(qualityOptions.llm || {}),
              mode: row.__llm_mode || qualityOptions?.llm?.mode || 'auto',
            },
          },
          runId,
          jobId: row.id,
        });
        const nextStatus = fit.admittedToInbox ? 'inbox' : 'filtered';
        const update = await dbRun(
          `UPDATE job_queue
           SET status = ?, fit_score = ?, fit_label = ?, fit_source = ?, fit_reason_codes = ?,
               quality_bucket = ?, rejected_by_quality = ?, llm_confidence = ?, llm_missing_must_have = ?,
               last_run_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'inbox'`,
          [
            nextStatus,
            fit.fitScore,
            fit.fitLabel,
            fit.fitSource,
            JSON.stringify(fit.reasonCodes || []),
            fit.qualityBucket,
            fit.admittedToInbox ? 0 : 1,
            fit.llmConfidence,
            JSON.stringify(fit.missingMustHave || []),
            runId,
            row.id,
          ]
        );

        if (!update.changes) {
          summary.totals.skipped += 1;
          syncRunProgress(runId, summary, 'running');
          continue;
        }

        summary.totals.reevaluated += 1;
        if (fit.llmUsed) summary.quality.llmUsed += 1;
        if (fit.llmEligible) {
          summary.llm.eligible += 1;
          if (fit.llmAttempted) summary.llm.attempted += 1;
          if (fit.llmUsed) summary.llm.completed += 1;
          else if (fit.llmQueued) summary.llm.batchQueued = (summary.llm.batchQueued || 0) + 1;
          else summary.llm.skipped += 1;
        }

        if (fit.admittedToInbox) {
          summary.totals.kept += 1;
          summary.quality.admittedToInbox += 1;
        } else {
          summary.totals.filtered += 1;
          summary.quality.filteredOut += 1;
        }

        await addJobEvent({
          jobId: row.id,
          runId,
          eventType: fit.admittedToInbox ? 'cleanup_kept' : 'cleanup_filtered',
          message: fit.admittedToInbox
            ? 'Manual inbox cleanup kept this listing in inbox'
            : 'Manual inbox cleanup moved listing to filtered',
          payload: {
            fitScore: fit.fitScore,
            fitLabel: fit.fitLabel,
            fitSource: fit.fitSource,
            qualityBucket: fit.qualityBucket,
            reasonCodes: fit.reasonCodes || [],
            llmUsed: !!fit.llmUsed,
          },
        });
        syncRunProgress(runId, summary, 'running');
      } catch (err) {
        summary.totals.failed += 1;
        summary.sources.cleanup_inbox.failed += 1;
        summary.errors.push(`cleanup_inbox#${row.id}: ${err.message}`);
        syncRunProgress(runId, summary, 'running');
      }
    }

    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - start;
    const batchFlush = await flushBatchForRun({ runId, options: qualityOptions.llm || {} });
    if (batchFlush?.batchId) {
      summary.llm.batchSubmitted = batchFlush.submitted || 0;
      summary.llm.batchId = batchFlush.batchId;
    } else if (batchFlush?.error) {
      summary.errors.push(`llm_batch: ${batchFlush.error}`);
    }
    const status = summary.errors.length ? (summary.totals.reevaluated ? 'partial' : 'failed') : 'success';
    await finalizeRun(runId, status, summary, summary.errors.join(' | ') || null);
    syncRunProgress(runId, summary, status);

    return {
      runId,
      status,
      accepted: true,
      message: `Inbox cleanup finished with status=${status}`,
      summary,
    };
  } catch (err) {
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - start;
    summary.errors.push(err.message);
    await finalizeRun(runId, 'failed', summary, err.message);
    syncRunProgress(runId, summary, 'failed');
    return {
      runId,
      status: 'failed',
      accepted: true,
      message: err.message,
      summary,
    };
  } finally {
    isCleanupRunning = false;
  }
}

const FETCH_INTERVAL = FETCH_INTERVAL_MIN * 60 * 1000;
const SERPAPI_FETCH_INTERVAL = SERPAPI_FETCH_INTERVAL_MIN * 60 * 1000;
const BIGTECH_FETCH_INTERVAL = BIGTECH_FETCH_INTERVAL_MIN * 60 * 1000;
let scheduled = null;
let scheduledBigTech = null;
let scheduledSerpApi = null;
let scheduledLlmBatchPoll = null;

async function startScheduler() {
  if (RUN_ON_STARTUP) {
    runFetcher('startup').catch((err) => console.error('[Scheduler] startup run failed:', err.message));
  }
  scheduled = setInterval(() => {
    runFetcher('scheduler').catch((err) => console.error('[Scheduler] scheduled run failed:', err.message));
  }, FETCH_INTERVAL);

  if (SERPAPI_RUN_ON_STARTUP) {
    runSerpFetcher('startup_serpapi').catch((err) => console.error('[SerpAPI] startup run failed:', err.message));
  }
  scheduledSerpApi = setInterval(() => {
    runSerpFetcher('scheduler_serpapi').catch((err) => console.error('[SerpAPI] scheduled run failed:', err.message));
  }, SERPAPI_FETCH_INTERVAL);

  if (RUN_ON_STARTUP_BIGTECH) {
    runBigTechFetcher('startup_bigtech').catch((err) => console.error('[BigTech] startup run failed:', err.message));
  }
  scheduledBigTech = setInterval(() => {
    runBigTechFetcher('scheduler_bigtech').catch((err) => console.error('[BigTech] scheduled run failed:', err.message));
  }, BIGTECH_FETCH_INTERVAL);

  if (LLM_BATCH_ENABLED) {
    scheduledLlmBatchPoll = setInterval(() => {
      pollAndReconcileBatches({
        options: { llmAdmitThreshold: QUALITY_LLM_ADMIT_THRESHOLD },
      }).catch((err) => console.error('[LLM Batch] poll failed:', err.message));
    }, Math.max(10, LLM_BATCH_POLL_INTERVAL_SEC) * 1000);
  }

  console.log(`[Scheduler] Next core fetch in ${FETCH_INTERVAL / 60000} minutes`);
  console.log(`[SerpAPI] Next serpapi fetch in ${SERPAPI_FETCH_INTERVAL / 60000} minutes`);
  console.log(`[BigTech] Next big-tech fetch in ${BIGTECH_FETCH_INTERVAL / 60000} minutes`);
}

(async () => {
  await initDB();
  await startScheduler();

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      now: new Date().toISOString(),
      sources: {
        greenhouseBoards: TARGET_BOARDS.length,
        leverBoards: LEVER_TARGETS.length,
        ashbyTargets: ASHBY_TARGETS.length,
        workdayTargets: WORKDAY_TARGETS.length,
        serpQueries: SERP_QUERIES.length,
        bigTechGreenhouseBoards: BIGTECH_GREENHOUSE_BOARDS.length,
        bigTechLeverBoards: BIGTECH_LEVER_BOARDS.length,
        bigTechAmazonQueries: BIGTECH_AMAZON_QUERIES.length,
      },
      quality: {
        minInboxScore: QUALITY_MIN_INBOX_SCORE,
        borderlineMin: QUALITY_BORDERLINE_MIN,
        borderlineMax: QUALITY_BORDERLINE_MAX,
        llmAdmitThreshold: QUALITY_LLM_ADMIT_THRESHOLD,
        llmEnabled: LLM_ENABLED,
        llmDailyCap: LLM_DAILY_CAP,
      },
      missingConfig: missingSourceConfig(),
    });
  });

  app.get('/api/scheduler/stats', (req, res) => {
    res.json({
      greenhouseBoards: TARGET_BOARDS.length,
      leverBoards: LEVER_TARGETS.length,
      ashbyTargets: ASHBY_TARGETS.length,
      workdayTargets: WORKDAY_TARGETS.length,
      serpQueries: SERP_QUERIES.length,
      intervalMs: FETCH_INTERVAL,
      serpApiIntervalMs: SERPAPI_FETCH_INTERVAL,
      bigTechIntervalMs: BIGTECH_FETCH_INTERVAL,
      coreRunning: isFetching,
      serpApiRunning: isSerpFetching,
      bigTechRunning: isBigTechFetching,
      nextRunIn: scheduled ? 'active (interval)' : 'stopped',
      nextSerpApiRunIn: scheduledSerpApi ? 'active (interval)' : 'stopped',
      nextBigTechRunIn: scheduledBigTech ? 'active (interval)' : 'stopped',
      quality: {
        minInboxScore: QUALITY_MIN_INBOX_SCORE,
        borderlineMin: QUALITY_BORDERLINE_MIN,
        borderlineMax: QUALITY_BORDERLINE_MAX,
        llmAdmitThreshold: QUALITY_LLM_ADMIT_THRESHOLD,
        llmEnabled: LLM_ENABLED,
        llmDailyCap: LLM_DAILY_CAP,
        llmMaxPerRun: LLM_MAX_PER_RUN,
        llmBatchEnabled: LLM_BATCH_ENABLED,
        llmBatchThreshold: LLM_BATCH_THRESHOLD,
        llmBatchRealtimeFallbackCount: LLM_BATCH_REALTIME_FALLBACK_COUNT,
        llmBatchPollIntervalSec: LLM_BATCH_POLL_INTERVAL_SEC,
      },
      missingConfig: missingSourceConfig(),
    });
  });

  app.get('/api/ingestion/runs', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    try {
      const rows = await dbAll(
        `SELECT id, started_at, finished_at, trigger_type, status, summary_json, error_text
         FROM ingestion_runs
         ORDER BY id DESC
         LIMIT ?`,
        [limit]
      );

      const items = rows.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        trigger: r.trigger_type,
        status: r.status,
        errorText: r.error_text,
        summary: (() => {
          try {
            return r.summary_json ? JSON.parse(r.summary_json) : null;
          } catch {
            return null;
          }
        })(),
      }));

      res.json({ items, meta: { limit, total: items.length } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/ingestion/runs/:id/progress', async (req, res) => {
    const runId = parseInt(req.params.id || '0', 10);
    if (!runId) return res.status(400).json({ error: 'invalid run id' });

    const live = runProgress.get(runId);
    if (live) return res.json(live);

    try {
      const row = await dbGet(
        `SELECT id, started_at, finished_at, trigger_type, status, summary_json
         FROM ingestion_runs
         WHERE id = ?
         LIMIT 1`,
        [runId]
      );
      if (!row) return res.status(404).json({ error: 'run not found' });

      let summary = {};
      try {
        summary = row.summary_json ? JSON.parse(row.summary_json) : {};
      } catch {
        summary = {};
      }

      const quality = summary.quality || {};
      const llm = normalizeLlmProgress(
        summary.llm || { completed: Number(quality.llmUsed) || 0 }
      );

      return res.json({
        runId: row.id,
        trigger: row.trigger_type,
        label: summary.label || 'unknown',
        status: row.status,
        totals: summary.totals || {},
        quality,
        llm,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        updatedAt: row.finished_at || row.started_at || new Date().toISOString(),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/scheduler/run', async (req, res) => {
    const llmMode = clampLlmMode(req.body?.llmMode || 'auto');
    const result = await runFetcher('manual', { llmMode });
    res.json(result);
  });

  app.post('/api/scheduler/run-serpapi', async (req, res) => {
    const llmMode = clampLlmMode(req.body?.llmMode || 'auto');
    const result = await runSerpFetcher('manual_serpapi', { llmMode });
    res.json(result);
  });

  app.post('/api/scheduler/cleanup-inbox', async (req, res) => {
    const llmMode = clampLlmMode(req.body?.llmMode || 'auto');
    const result = await runInboxCleanup('manual_cleanup', { llmMode });
    res.json(result);
  });

  app.post('/api/llm/batch/requeue-failed', async (req, res) => {
    try {
      const batchQualityOptions = buildQualityOptionsForRun('batch');
      const rows = await dbAll(
        `SELECT id, company, title, location, post_date, source, url, jd_text, is_bigtech, last_run_id
         FROM job_queue
         WHERE llm_review_state = 'failed'
         ORDER BY id DESC
         LIMIT 500`
      );
      let queued = 0;
      for (const row of rows) {
        const fit = await evaluateJobFit({
          normalizedJob: normalizeJob(row),
          profile,
          qualityOptions: {
            ...batchQualityOptions,
            llm: { ...(batchQualityOptions.llm || {}), mode: 'batch' },
          },
          runId: row.last_run_id || null,
          jobId: row.id,
        });
        if (fit.llmQueued) {
          await dbRun(
            `UPDATE job_queue
             SET llm_review_state = 'pending', llm_review_error = NULL, llm_pending_custom_id = ?,
                 llm_review_updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [fit.llmPendingCustomId || null, row.id]
          );
          queued += 1;
        }
      }
      res.json({ queued });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use('/jobs', jobsRouter);
  app.use('/', express.static(path.join(__dirname, 'ui')));

  const port = process.env.PORT || 3030;
  app.listen(port, () => {
    console.log(`Job Engine listening on http://localhost:${port}`);
  });
})().catch((err) => {
  console.error('Failed to init', err);
  process.exit(1);
});
