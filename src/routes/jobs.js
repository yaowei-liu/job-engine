const express = require('express');
const { db } = require('../lib/db');
const { scoreJD } = require('../lib/score');

const router = express.Router();

// Ingest a job (stub)
router.post('/ingest', (req, res) => {
  const { company, title, location, post_date, source, url, jd_text } = req.body || {};
  if (!company || !title) return res.status(400).json({ error: 'company and title required' });

  const { score, tier, hits } = scoreJD(jd_text, post_date);
  db.run(
    `INSERT INTO job_queue (company, title, location, post_date, source, url, jd_text, score, tier, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox')`,
    [company, title, location || null, post_date || null, source || null, url || null, jd_text || null, score, tier],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, score, tier, hits });
    }
  );
});

// List jobs
router.get('/', (req, res) => {
  const { tier, status, source, q, minScore, sort } = req.query;
  let sql = 'SELECT * FROM job_queue WHERE 1=1';
  const params = [];

  if (tier) { sql += ' AND tier = ?'; params.push(tier); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (source) { sql += ' AND source = ?'; params.push(source); }
  if (q) {
    sql += ' AND (title LIKE ? OR company LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (minScore) {
    sql += ' AND score >= ?';
    params.push(Number(minScore));
  }

  const sortMap = {
    newest: 'post_date DESC, score DESC',
    oldest: 'post_date ASC, score DESC',
    score: 'score DESC, post_date DESC',
    company: 'company ASC, score DESC',
  };
  sql += ` ORDER BY ${sortMap[sort] || 'post_date DESC, score DESC'}`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Approve/skip
router.post('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!['approved', 'skipped'].includes(status)) return res.status(400).json({ error: 'invalid status' });

  db.run('UPDATE job_queue SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    if (status === 'approved') {
      // Fire-and-forget sync to personal dashboard
      syncToPersonalDashboard(id).catch(() => {});
    }

    res.json({ updated: this.changes });
  });
});

// Skip all jobs from a company
router.post('/company/skip', (req, res) => {
  const { company } = req.body || {};
  if (!company) return res.status(400).json({ error: 'company required' });

  db.run('UPDATE job_queue SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE company = ?', ['skipped', company], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ updated: this.changes });
  });
});

async function syncToPersonalDashboard(jobId) {
  const { db: pdDB } = require('../lib/pd');
  const { sendWebhook } = require('../lib/webhook');

  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM job_queue WHERE id = ?', [jobId], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve();

      const notes = `Auto-synced from Job Engine. Tier ${row.tier}. Score ${row.score}. Source: ${row.source || 'unknown'}.`;

      // Webhook (preferred)
      sendWebhook({
        company: row.company,
        position: row.title,
        status: 'applied',
        location: row.location || null,
        applied_date: new Date().toISOString().slice(0, 10),
        notes,
        url: row.url || null,
        external_id: row.id
      }).catch(() => {});

      // DB fallback (local integration)
      pdDB.run(
        `INSERT INTO job_applications (company, position, status, location, applied_date, notes, url)
         VALUES (?, ?, 'applied', ?, date('now'), ?, ?)`,
        [row.company, row.title, row.location || null, notes, row.url || null],
        function (pdErr) {
          if (pdErr) return reject(pdErr);
          resolve();
        }
      );
    });
  });
}


module.exports = router;
