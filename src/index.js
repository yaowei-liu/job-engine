require('dotenv').config();

const express = require('express');
const path = require('path');
const { initDB } = require('./lib/db');
const jobsRouter = require('./routes/jobs');
const { fetchAll: fetchGreenhouse, DEFAULT_BOARDS: GH_BOARDS } = require('./lib/sources/greenhouse');
const { fetchAll: fetchLever, DEFAULT_BOARDS: LEVER_BOARDS } = require('./lib/sources/lever');
const { fetchAll: fetchSerp } = require('./lib/sources/serpapi');
const { fetchAll: fetchAmazon } = require('./lib/sources/amazon');
const { scoreJD } = require('./lib/score');
const { extractYearsRequirement } = require('./lib/jdExtract');
const { loadSearchConfig, buildQueriesFromConfig } = require('./lib/searchConfig');

const app = express();
app.use(express.json());

// Config
const TARGET_BOARDS = (process.env.GREENHOUSE_BOARDS || GH_BOARDS.join(','))
  .split(',')
  .filter(Boolean);
const LEVER_TARGETS = (process.env.LEVER_BOARDS || LEVER_BOARDS.join(','))
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

// Ingest a single job into the queue
async function ingestJob(job) {
  const { db } = require('./lib/db');

  const { score, tier, hits } = scoreJD(job.jd_text, job.post_date, job.title);
  const years_req = extractYearsRequirement(job.jd_text);
  const companyKey = (job.company || '').trim().toLowerCase();
  const titleKey = (job.title || '').trim().toLowerCase();

  return new Promise((resolve, reject) => {
    // De-dupe by company + title (URL can be null or vary)
    db.get(
      'SELECT id FROM job_queue WHERE lower(company) = ? AND lower(title) = ? LIMIT 1',
      [companyKey, titleKey],
      (checkErr, row) => {
        if (checkErr) return reject(checkErr);
        if (row) return resolve({ id: row.id, skipped: true, score, tier, hits, title: job.title });

        db.run(
          `INSERT OR IGNORE INTO job_queue (company, title, location, post_date, source, url, jd_text, score, tier, status, hits, years_req, is_bigtech)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?)`,
          [job.company, job.title, job.location, job.post_date, job.source, job.url, job.jd_text, score, tier, JSON.stringify(hits), years_req, job.is_bigtech ? 1 : 0],
          function (err) {
            if (err) return reject(err);
            resolve({ id: this.lastID, score, tier, hits, title: job.title });
          }
        );
      }
    );
  });
}

// Fetch and ingest jobs from all sources
async function runFetcher() {
  console.log(`[Scheduler] Fetching jobs...`);
  const start = Date.now();

  try {
    const [greenhouseJobs, leverJobs, serpJobs] = await Promise.all([
      TARGET_BOARDS.length ? fetchGreenhouse(TARGET_BOARDS) : Promise.resolve([]),
      LEVER_TARGETS.length ? fetchLever(LEVER_TARGETS) : Promise.resolve([]),
      SERP_QUERIES.length ? fetchSerp(SERP_QUERIES, SERP_LOCATION) : Promise.resolve([]),
    ]);

    console.log(`[Scheduler] Sources: greenhouse=${greenhouseJobs.length}, lever=${leverJobs.length}, serpapi=${serpJobs.length}`);

    const jobs = [...greenhouseJobs, ...leverJobs, ...serpJobs].map((j) => ({ ...j, is_bigtech: false }));
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

async function runBigTechFetcher() {
  console.log(`[BigTech] Fetching jobs...`);
  const start = Date.now();

  try {
    const [greenhouseJobs, leverJobs, amazonJobs] = await Promise.all([
      BIGTECH_GREENHOUSE_BOARDS.length ? fetchGreenhouse(BIGTECH_GREENHOUSE_BOARDS) : Promise.resolve([]),
      BIGTECH_LEVER_BOARDS.length ? fetchLever(BIGTECH_LEVER_BOARDS) : Promise.resolve([]),
      fetchAmazon({ baseQueries: BIGTECH_AMAZON_QUERIES, locQueries: BIGTECH_AMAZON_LOCATIONS }),
    ]);

    const jobs = [...greenhouseJobs, ...leverJobs, ...amazonJobs]
      .filter((j) => isTorontoOrRemote(j.location) || j.meta?.is_virtual)
      .map((j) => ({ ...j, is_bigtech: true }));

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
          console.error(`[BigTech] Ingest error: ${err.message}`);
        }
      }
    }

    const dur = Date.now() - start;
    console.log(`[BigTech] Done. Ingested ${ingested}, skipped ${skipped}, took ${dur}ms`);
  } catch (err) {
    console.error('[BigTech] Fetch failed:', err.message);
  }
}

// Scheduler: run every N minutes
const FETCH_INTERVAL_MIN = parseInt(process.env.FETCH_INTERVAL_MIN || '15', 10);
const FETCH_INTERVAL = FETCH_INTERVAL_MIN * 60 * 1000;
const BIGTECH_FETCH_INTERVAL_MIN = parseInt(process.env.BIGTECH_FETCH_INTERVAL_MIN || '1440', 10);
const BIGTECH_FETCH_INTERVAL = BIGTECH_FETCH_INTERVAL_MIN * 60 * 1000;
let scheduled = null;
let scheduledBigTech = null;

async function startScheduler() {
  const runOnStartup = (process.env.RUN_ON_STARTUP || 'true').toLowerCase() === 'true';
  if (runOnStartup) {
    runFetcher();
  }
  scheduled = setInterval(runFetcher, FETCH_INTERVAL);
  console.log(`[Scheduler] Next fetch in ${FETCH_INTERVAL / 60000} minutes`);

  const runOnStartupBig = (process.env.RUN_ON_STARTUP_BIGTECH || 'true').toLowerCase() === 'true';
  if (runOnStartupBig) {
    runBigTechFetcher();
  }
  scheduledBigTech = setInterval(runBigTechFetcher, BIGTECH_FETCH_INTERVAL);
  console.log(`[BigTech] Next fetch in ${BIGTECH_FETCH_INTERVAL / 60000} minutes`);
}

(async () => {
  await initDB();
  await startScheduler();

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/api/scheduler/stats', (req, res) => {
    res.json({
      greenhouseBoards: TARGET_BOARDS.length,
      leverBoards: LEVER_TARGETS.length,
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
