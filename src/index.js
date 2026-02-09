require('dotenv').config();

const express = require('express');
const path = require('path');
const { initDB, dbAll, dbRun } = require('./lib/db');
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

function buildQualityOptionsForRun() {
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
    },
  };
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

async function runPipeline({ triggerType, label, sourceTasks, transform = (jobs) => jobs, qualityOptions = {} }) {
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
    sources: {},
    errors: [],
  };

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

    const jobs = transform(sourceResults.flatMap((r) => r.jobs));

    for (const job of jobs) {
      const source = (job.source || 'unknown').toLowerCase();
      if (!summary.sources[source]) {
        summary.sources[source] = { fetched: 0, inserted: 0, deduped: 0, failed: 0, error: null };
      }

      try {
        const result = await ingestJob({ ...job, profile, quality_options: runQualityOptions }, runId);
        if (result.skipped) {
          summary.totals.skipped += 1;
          continue;
        }
        if (result.admittedToInbox) qualitySummary.admittedToInbox += 1;
        else qualitySummary.filteredOut += 1;
        if (result.llmUsed) qualitySummary.llmUsed += 1;
        if (result.deduped) {
          summary.totals.deduped += 1;
          summary.sources[source].deduped += 1;
        } else {
          summary.totals.inserted += 1;
          summary.sources[source].inserted += 1;
        }
      } catch (err) {
        summary.totals.failed += 1;
        summary.sources[source].failed += 1;
        summary.errors.push(`${source}: ${err.message}`);
      }
    }

    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - start;

    const status = summary.errors.length ? (summary.totals.inserted || summary.totals.deduped ? 'partial' : 'failed') : 'success';
    await finalizeRun(runId, status, summary, summary.errors.join(' | ') || null);

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
    return {
      runId,
      status: 'failed',
      accepted: true,
      message: err.message,
      summary,
    };
  }
}

async function runFetcher(triggerType = 'manual') {
  if (isFetching) {
    return {
      accepted: false,
      status: 'running',
      message: 'Scheduler run already in progress',
    };
  }

  isFetching = true;
  try {
    const response = await runPipeline({
      triggerType,
      label: 'core',
      qualityOptions: buildQualityOptionsForRun(),
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

async function runSerpFetcher(triggerType = 'scheduler_serpapi') {
  if (isSerpFetching) {
    return {
      accepted: false,
      status: 'running',
      message: 'SerpAPI run already in progress',
    };
  }

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
      qualityOptions: buildQualityOptionsForRun(),
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

async function runBigTechFetcher(triggerType = 'scheduler_bigtech') {
  if (isBigTechFetching) {
    return {
      accepted: false,
      status: 'running',
      message: 'Big tech run already in progress',
    };
  }

  isBigTechFetching = true;
  try {
    const response = await runPipeline({
      triggerType,
      label: 'bigtech',
      qualityOptions: buildQualityOptionsForRun(),
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

async function runInboxCleanup(triggerType = 'manual_cleanup') {
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
  const qualityOptions = buildQualityOptionsForRun();
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

  try {
    const rows = await dbAll(
      `SELECT id, company, title, location, post_date, source, url, jd_text, is_bigtech
       FROM job_queue
       WHERE status = 'inbox'
       ORDER BY id DESC`
    );
    summary.totals.fetched = rows.length;
    summary.sources.cleanup_inbox.fetched = rows.length;

    for (const row of rows) {
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
          qualityOptions,
          runId,
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
          continue;
        }

        summary.totals.reevaluated += 1;
        if (fit.llmUsed) summary.quality.llmUsed += 1;

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
      } catch (err) {
        summary.totals.failed += 1;
        summary.sources.cleanup_inbox.failed += 1;
        summary.errors.push(`cleanup_inbox#${row.id}: ${err.message}`);
      }
    }

    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - start;
    const status = summary.errors.length ? (summary.totals.reevaluated ? 'partial' : 'failed') : 'success';
    await finalizeRun(runId, status, summary, summary.errors.join(' | ') || null);

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

  app.post('/api/scheduler/run', async (req, res) => {
    const result = await runFetcher('manual');
    res.json(result);
  });

  app.post('/api/scheduler/run-serpapi', async (req, res) => {
    const result = await runSerpFetcher('manual_serpapi');
    res.json(result);
  });

  app.post('/api/scheduler/cleanup-inbox', async (req, res) => {
    const result = await runInboxCleanup('manual_cleanup');
    res.json(result);
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
