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
  const { tier, status } = req.query;
  let sql = 'SELECT * FROM job_queue WHERE 1=1';
  const params = [];
  if (tier) { sql += ' AND tier = ?'; params.push(tier); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY post_date DESC, score DESC';

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
    res.json({ updated: this.changes });
  });
});

module.exports = router;
