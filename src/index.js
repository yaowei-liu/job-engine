require('dotenv').config();

const express = require('express');
const path = require('path');
const { initDB, dbAll } = require('./lib/db');
const jobsRouter = require('./routes/jobs');
const { fetchAll: fetchGreenhouse, DEFAULT_BOARDS: GH_BOARDS } = require('./lib/sources/greenhouse');
const { fetchAll: fetchLever, DEFAULT_BOARDS: LEVER_BOARDS } = require('./lib/sources/lever');
const { fetchAll: fetchSerp } = require('./lib/sources/serpapi');
const { fetchAll: fetchAmazon } = require('./lib/sources/amazon');
const { loadSearchConfig, buildQueriesFromConfig } = require('./lib/searchConfig');
const { createRun, finalizeRun, ingestJob } = require('./lib/ingestion');

const app = express();
app.use(express.json());

const TARGET_BOARDS = (process.env.GREENHOUSE_BOARDS || GH_BOARDS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LEVER_TARGETS = (process.env.LEVER_BOARDS || LEVER_BOARDS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const searchCfg = loadSearchConfig();
const SERP_QUERIES = (buildQueriesFromConfig(searchCfg) || [])
  .concat(
    (process.env.SERPAPI_QUERIES || '')
      .split(',')
      .map((q) => q.trim())
      .filter(Boolean)
  )
  .filter(Boolean);

const SERP_LOCATION = (process.env.SERPAPI_LOCATION || '').trim();

const BIGTECH_LEVER_BOARDS = (process.env.BIGTECH_LEVER_BOARDS || '')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);
const BIGTECH_GREENHOUSE_BOARDS = (process.env.BIGTECH_GREENHOUSE_BOARDS || '')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);
const BIGTECH_AMAZON_QUERIES = (process.env.BIGTECH_AMAZON_QUERIES || 'software engineer,backend engineer,full stack,entry level,new grad,early career')
  .split(',')
  .map((q) => q.trim())
  .filter(Boolean);
const BIGTECH_AMAZON_LOCATIONS = (process.env.BIGTECH_AMAZON_LOCATIONS || 'Toronto, ON, Canada,Canada,Remote')
  .split(',')
  .map((q) => q.trim())
  .filter(Boolean);

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
  if (!TARGET_BOARDS.length && !LEVER_TARGETS.length && !SERP_QUERIES.length) {
    missing.push('No core source targets configured (GREENHOUSE_BOARDS / LEVER_BOARDS / SERPAPI_QUERIES).');
  }
  if (SERP_QUERIES.length && !process.env.SERPAPI_KEY) {
    missing.push('SERPAPI_KEY is missing while SERPAPI_QUERIES are configured.');
  }
  return missing;
}

let isFetching = false;
let isBigTechFetching = false;

async function runPipeline({ triggerType, label, sourceTasks, transform = (jobs) => jobs }) {
  const runId = await createRun(triggerType);
  const start = Date.now();

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
    sources: {},
    errors: [],
  };

  try {
    const sourceResults = await Promise.all(
      sourceTasks.map(async (task) => {
        try {
          const jobs = await task.fetch();
          return { source: task.source, jobs, error: null };
        } catch (err) {
          return { source: task.source, jobs: [], error: err.message };
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
        const result = await ingestJob(job, runId);
        if (result.skipped) {
          summary.totals.skipped += 1;
          continue;
        }
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
          source: 'serpapi',
          fetch: () => (SERP_QUERIES.length ? fetchSerp(SERP_QUERIES, SERP_LOCATION) : Promise.resolve([])),
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

const rawIntervalMin = parseInt(process.env.FETCH_INTERVAL_MIN || '15', 10);
const FETCH_INTERVAL_MIN = Number.isFinite(rawIntervalMin) && rawIntervalMin > 0 ? rawIntervalMin : 15;
const FETCH_INTERVAL = FETCH_INTERVAL_MIN * 60 * 1000;
const BIGTECH_FETCH_INTERVAL_MIN = parseInt(process.env.BIGTECH_FETCH_INTERVAL_MIN || '1440', 10);
const BIGTECH_FETCH_INTERVAL = BIGTECH_FETCH_INTERVAL_MIN * 60 * 1000;
let scheduled = null;
let scheduledBigTech = null;

async function startScheduler() {
  const runOnStartup = (process.env.RUN_ON_STARTUP || 'true').toLowerCase() === 'true';
  if (runOnStartup) {
    runFetcher('startup').catch((err) => console.error('[Scheduler] startup run failed:', err.message));
  }
  scheduled = setInterval(() => {
    runFetcher('scheduler').catch((err) => console.error('[Scheduler] scheduled run failed:', err.message));
  }, FETCH_INTERVAL);

  const runOnStartupBig = (process.env.RUN_ON_STARTUP_BIGTECH || 'true').toLowerCase() === 'true';
  if (runOnStartupBig) {
    runBigTechFetcher('startup_bigtech').catch((err) => console.error('[BigTech] startup run failed:', err.message));
  }
  scheduledBigTech = setInterval(() => {
    runBigTechFetcher('scheduler_bigtech').catch((err) => console.error('[BigTech] scheduled run failed:', err.message));
  }, BIGTECH_FETCH_INTERVAL);

  console.log(`[Scheduler] Next core fetch in ${FETCH_INTERVAL / 60000} minutes`);
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
        serpQueries: SERP_QUERIES.length,
        bigTechGreenhouseBoards: BIGTECH_GREENHOUSE_BOARDS.length,
        bigTechLeverBoards: BIGTECH_LEVER_BOARDS.length,
        bigTechAmazonQueries: BIGTECH_AMAZON_QUERIES.length,
      },
      missingConfig: missingSourceConfig(),
    });
  });

  app.get('/api/scheduler/stats', (req, res) => {
    res.json({
      greenhouseBoards: TARGET_BOARDS.length,
      leverBoards: LEVER_TARGETS.length,
      serpQueries: SERP_QUERIES.length,
      intervalMs: FETCH_INTERVAL,
      bigTechIntervalMs: BIGTECH_FETCH_INTERVAL,
      coreRunning: isFetching,
      bigTechRunning: isBigTechFetching,
      nextRunIn: scheduled ? 'active (interval)' : 'stopped',
      nextBigTechRunIn: scheduledBigTech ? 'active (interval)' : 'stopped',
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
