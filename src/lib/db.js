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
        } catch (e) {
          return reject(e);
        }

        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_company_title_loc_date ON job_queue(company_key, title_key, location_key, post_date_key)`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_fingerprint ON job_queue(canonical_fingerprint) WHERE canonical_fingerprint IS NOT NULL`);
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
