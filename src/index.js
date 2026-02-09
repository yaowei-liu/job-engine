require('dotenv').config();

const express = require('express');
const path = require('path');
const { initDB } = require('./lib/db');
const jobsRouter = require('./routes/jobs');
const { fetchAll: fetchGreenhouse, DEFAULT_BOARDS } = require('./lib/sources/greenhouse');
const { fetchAll: fetchSerp } = require('./lib/sources/serpapi');
const { loadSearchConfig, buildQueriesFromConfig } = require('./lib/searchConfig');

const app = express();
app.use(express.json());

// Config
const TARGET_BOARDS = (process.env.GREENHOUSE_BOARDS || DEFAULT_BOARDS.join(','))
  .split(',')
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

const SERP_LOCATION = process.env.SERPAPI_LOCATION ? process.env.SERPAPI_LOCATION.trim() : undefined;

// Ingest a single job into the queue
async function ingestJob(job) {
  const { db } = require('./lib/db');
  const { scoreJD } = require('./lib/score');

  const { score, tier, hits } = scoreJD(job.jd_text, job.post_date);

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO job_queue (company, title, location, post_date, source, url, jd_text, score, tier, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox')`,
      [job.company, job.title, job.location, job.post_date, job.source, job.url, job.jd_text, score, tier],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, score, tier, hits, title: job.title });
      }
    );
  });
}

// Fetch and ingest jobs from all sources
async function runFetcher() {
  console.log(`[Scheduler] Fetching jobs...`);
  const start = Date.now();

  try {
    const [greenhouseJobs, serpJobs] = await Promise.all([
      TARGET_BOARDS.length ? fetchGreenhouse(TARGET_BOARDS) : Promise.resolve([]),
      SERP_QUERIES.length ? fetchSerp(SERP_QUERIES, SERP_LOCATION) : Promise.resolve([]),
    ]);

    console.log(`[Scheduler] Sources: greenhouse=${greenhouseJobs.length}, serpapi=${serpJobs.length}`);

    const jobs = [...greenhouseJobs, ...serpJobs];
    let ingested = 0;
    let skipped = 0;

    for (const job of jobs) {
      try {
        await ingestJob(job);
        ingested++;
      } catch (err) {
        if (err.message.includes('UNIQUE')) {
          skipped++;
        } else {
          console.error(`[Scheduler] Ingest error: ${err.message}`);
        }
      }
    }

    const dur = Date.now() - start;
    console.log(`[Scheduler] Done. Ingested ${ingested}, skipped ${skipped}, took ${dur}ms`);
  } catch (err) {
    console.error('[Scheduler] Fetch failed:', err.message);
  }
}

// Scheduler: run every 15 minutes
const FETCH_INTERVAL = 15 * 60 * 1000;
let scheduled = null;

async function startScheduler() {
  runFetcher();
  scheduled = setInterval(runFetcher, FETCH_INTERVAL);
  console.log(`[Scheduler] Next fetch in ${FETCH_INTERVAL / 60000} minutes`);
}

(async () => {
  await initDB();
  await startScheduler();

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/api/scheduler/stats', (req, res) => {
    res.json({
      greenhouseBoards: TARGET_BOARDS.length,
      serpQueries: SERP_QUERIES.length,
      intervalMs: FETCH_INTERVAL,
      nextRunIn: scheduled ? 'N/A (interval active)' : 'stopped',
    });
  });
  app.post('/api/scheduler/run', async (req, res) => {
    await runFetcher();
    res.json({ ok: true });
  });
  app.use('/jobs', jobsRouter);
  app.use('/', express.static(path.join(__dirname, 'ui')));

  const port = process.env.PORT || 3030;
  app.listen(port, () => {
    console.log(`🚀 Job Engine listening on http://localhost:${port}`);
    console.log(`   UI: http://localhost:${port}/`);
  });
})().catch((err) => {
  console.error('Failed to init', err);
  process.exit(1);
});
