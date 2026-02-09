const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/job-engine.db');
const dbDir = path.dirname(DB_PATH);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

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
        } catch (e) {
          return reject(e);
        }

        db.run(`
          CREATE TABLE IF NOT EXISTS preferences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rules_json TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err2) => {
          if (err2) return reject(err2);
          resolve();
        });
      });
    });
  });
}

module.exports = { db, initDB };
