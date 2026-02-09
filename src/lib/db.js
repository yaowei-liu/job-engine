const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/job-engine.db');
const dbDir = path.dirname(DB_PATH);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function ensureColumn(table, column, type) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => {
      if (err) return reject(err);
      const exists = rows.some((r) => r.name === column);
      if (exists) return resolve();
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

function initDB() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS job_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company TEXT NOT NULL,
          title TEXT NOT NULL,
          location TEXT,
          post_date TEXT,
          source TEXT,
          url TEXT,
          jd_text TEXT,
          score INTEGER DEFAULT 0,
          tier TEXT DEFAULT 'B',
          status TEXT DEFAULT 'inbox',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          company_key TEXT,
          title_key TEXT,
          location_key TEXT,
          post_date_key TEXT,
          UNIQUE(company, title, url)
        )
      `, async (err) => {
        if (err) return reject(err);
        db.run(`CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_job_queue_tier ON job_queue(tier)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_job_queue_post_date ON job_queue(post_date DESC)`);

        try {
          await ensureColumn('job_queue', 'hits', 'TEXT');
          await ensureColumn('job_queue', 'years_req', 'TEXT');
          await ensureColumn('job_queue', 'is_bigtech', 'INTEGER DEFAULT 0');
          await ensureColumn('job_queue', 'company_key', 'TEXT');
          await ensureColumn('job_queue', 'title_key', 'TEXT');
          await ensureColumn('job_queue', 'location_key', 'TEXT');
          await ensureColumn('job_queue', 'post_date_key', 'TEXT');
          await ensureColumn('job_queue', 'canonical_fingerprint', 'TEXT');
          await ensureColumn('job_queue', 'first_seen_at', 'DATETIME');
          await ensureColumn('job_queue', 'last_seen_at', 'DATETIME');
          await ensureColumn('job_queue', 'last_run_id', 'INTEGER');
          await ensureColumn('job_queue', 'dedup_reason', 'TEXT');
          await ensureColumn('job_queue', 'fit_score', 'INTEGER');
          await ensureColumn('job_queue', 'fit_label', 'TEXT');
          await ensureColumn('job_queue', 'fit_source', 'TEXT');
          await ensureColumn('job_queue', 'fit_reason_codes', 'TEXT');
          await ensureColumn('job_queue', 'quality_bucket', 'TEXT');
          await ensureColumn('job_queue', 'rejected_by_quality', 'INTEGER DEFAULT 0');
          await ensureColumn('job_queue', 'llm_confidence', 'REAL');
          await ensureColumn('job_queue', 'llm_missing_must_have', 'TEXT');
          await ensureColumn('job_queue', 'llm_review_state', 'TEXT');
          await ensureColumn('job_queue', 'llm_pending_batch_id', 'TEXT');
          await ensureColumn('job_queue', 'llm_pending_custom_id', 'TEXT');
          await ensureColumn('job_queue', 'llm_review_updated_at', 'DATETIME');
          await ensureColumn('job_queue', 'llm_review_error', 'TEXT');
        } catch (e) {
          return reject(e);
        }

        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_company_title_loc_date ON job_queue(company_key, title_key, location_key, post_date_key)`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_fingerprint ON job_queue(canonical_fingerprint) WHERE canonical_fingerprint IS NOT NULL`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_job_queue_quality_bucket ON job_queue(quality_bucket)`);
        db.run(`UPDATE job_queue SET company_key = lower(trim(company)) WHERE company_key IS NULL`);
        db.run(`UPDATE job_queue SET title_key = lower(trim(title)) WHERE title_key IS NULL`);
        db.run(`UPDATE job_queue SET location_key = lower(trim(COALESCE(location, ''))) WHERE location_key IS NULL`);
        db.run(`UPDATE job_queue SET post_date_key = COALESCE(post_date, '') WHERE post_date_key IS NULL`);
        db.run(`UPDATE job_queue SET first_seen_at = COALESCE(first_seen_at, created_at)`);
        db.run(`UPDATE job_queue SET last_seen_at = COALESCE(last_seen_at, updated_at)`);

        db.run(`
          CREATE TABLE IF NOT EXISTS preferences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rules_json TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, async (err2) => {
          if (err2) return reject(err2);

          try {
            await dbRun(`
              CREATE TABLE IF NOT EXISTS ingestion_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                finished_at DATETIME,
                trigger_type TEXT NOT NULL,
                status TEXT DEFAULT 'running',
                summary_json TEXT,
                error_text TEXT
              )
            `);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_ingestion_runs_started_at ON ingestion_runs(started_at DESC)`);

            await dbRun(`
              CREATE TABLE IF NOT EXISTS job_sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                run_id INTEGER,
                source TEXT,
                source_job_key TEXT,
                raw_post_date TEXT,
                normalized_post_date TEXT,
                ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                payload_hash TEXT,
                FOREIGN KEY(job_id) REFERENCES job_queue(id)
              )
            `);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_job_sources_job_id ON job_sources(job_id)`);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_job_sources_run_id ON job_sources(run_id)`);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_job_sources_key ON job_sources(source, source_job_key)`);

            await dbRun(`
              CREATE TABLE IF NOT EXISTS job_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                run_id INTEGER,
                event_type TEXT NOT NULL,
                message TEXT,
                payload_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(job_id) REFERENCES job_queue(id)
              )
            `);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id, created_at DESC)`);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_job_events_run_id ON job_events(run_id)`);

            await dbRun(`
              CREATE TABLE IF NOT EXISTS serpapi_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER,
                queries_used INTEGER NOT NULL DEFAULT 0,
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
            `);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_serpapi_usage_created_at ON serpapi_usage(created_at DESC)`);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_serpapi_usage_run_id ON serpapi_usage(run_id)`);

            await dbRun(`
              CREATE TABLE IF NOT EXISTS llm_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER,
                calls INTEGER NOT NULL DEFAULT 0,
                tokens_prompt INTEGER NOT NULL DEFAULT 0,
                tokens_completion INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
            `);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage(created_at DESC)`);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_llm_usage_run_id ON llm_usage(run_id)`);

            await dbRun(`
              CREATE TABLE IF NOT EXISTS llm_fit_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cache_key TEXT NOT NULL UNIQUE,
                fit_label TEXT,
                fit_score INTEGER DEFAULT 0,
                confidence REAL DEFAULT 0,
                reason_codes_json TEXT,
                missing_must_have_json TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
            `);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_llm_fit_cache_updated_at ON llm_fit_cache(updated_at DESC)`);

            await dbRun(`
              CREATE TABLE IF NOT EXISTS llm_batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER,
                batch_id TEXT NOT NULL UNIQUE,
                status TEXT DEFAULT 'submitted',
                model TEXT,
                input_file_id TEXT,
                output_file_id TEXT,
                error_file_id TEXT,
                error_text TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                failed_at DATETIME
              )
            `);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_llm_batches_run_id ON llm_batches(run_id)`);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_llm_batches_status ON llm_batches(status)`);

            await dbRun(`
              CREATE TABLE IF NOT EXISTS llm_batch_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER,
                batch_id TEXT,
                job_id INTEGER,
                cache_key TEXT,
                custom_id TEXT NOT NULL UNIQUE,
                state TEXT DEFAULT 'queued',
                error_text TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
            `);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_llm_batch_items_run_id ON llm_batch_items(run_id)`);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_llm_batch_items_batch_id ON llm_batch_items(batch_id)`);
            await dbRun(`CREATE INDEX IF NOT EXISTS idx_llm_batch_items_job_id ON llm_batch_items(job_id)`);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    });
  });
}

module.exports = { db, initDB, dbRun, dbGet, dbAll };
