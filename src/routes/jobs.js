const express = require('express');
const { dbAll, dbGet, dbRun } = require('../lib/db');
const { scoreJD } = require('../lib/score');
const { addJobEvent } = require('../lib/ingestion');
const { isValidWorkflowStatus } = require('../lib/jobStatus');

const router = express.Router();

router.post('/ingest', async (req, res) => {
  const { company, title, location, post_date, source, url, jd_text } = req.body || {};
  if (!company || !title) return res.status(400).json({ error: 'company and title required' });

  const { score, tier, hits } = scoreJD(jd_text, post_date, title);

  try {
    const result = await dbRun(
      `INSERT INTO job_queue (company, title, location, post_date, source, url, jd_text, score, tier, status, hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?)`,
      [company, title, location || null, post_date || null, source || null, url || null, jd_text || null, score, tier, JSON.stringify(hits)]
    );

    await addJobEvent({
      jobId: result.lastID,
      eventType: 'ingested',
      message: 'Manually ingested through /jobs/ingest',
      payload: { source: source || 'manual' },
    });

    res.json({ id: result.lastID, score, tier, hits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  const {
    tier,
    status,
    source,
    q,
    minScore,
    sort,
    bigtech,
    hasErrors,
    seenWithinDays,
    includeFiltered,
    page = '1',
    pageSize = '50',
    legacy,
  } = req.query;

  let whereSql = 'WHERE 1=1';
  const params = [];

  if (tier) {
    whereSql += ' AND tier = ?';
    params.push(tier);
  }
  if (status) {
    whereSql += ' AND status = ?';
    params.push(status);
  } else if (includeFiltered !== 'true') {
    whereSql += " AND status != 'filtered'";
  }
  if (source) {
    whereSql += ' AND source = ?';
    params.push(source);
  }
  if (bigtech === 'true') {
    whereSql += ' AND is_bigtech = 1';
  }
  if (q) {
    whereSql += ' AND (title LIKE ? OR company LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (minScore) {
    whereSql += ' AND score >= ?';
    params.push(Number(minScore));
  }
  if (hasErrors === 'true') {
    whereSql += ` AND id IN (
      SELECT DISTINCT job_id FROM job_events WHERE event_type IN ('sync_failed')
    )`;
  }
  if (seenWithinDays) {
    whereSql += ' AND datetime(last_seen_at) >= datetime(?, ?)';
    params.push('now', `-${Math.max(1, Number(seenWithinDays))} days`);
  }

  const sortMap = {
    newest: 'post_date DESC, score DESC',
    oldest: 'post_date ASC, score DESC',
    score: 'score DESC, post_date DESC',
    company: 'company ASC, score DESC',
  };

  const orderSql = ` ORDER BY ${sortMap[sort] || 'post_date DESC, score DESC'}`;
  const currentPage = Math.max(parseInt(page, 10) || 1, 1);
  const currentPageSize = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
  const offset = (currentPage - 1) * currentPageSize;

  try {
    const totalRow = await dbGet(`SELECT COUNT(*) AS total FROM job_queue ${whereSql}`, params);
    const items = await dbAll(
      `SELECT id, company, title, location, post_date, source, url, score, tier, status, hits, years_req,
              is_bigtech, first_seen_at, last_seen_at, dedup_reason, canonical_fingerprint,
              fit_score, fit_label, fit_source, fit_reason_codes, quality_bucket, rejected_by_quality,
              llm_confidence, llm_missing_must_have
       FROM job_queue
       ${whereSql}
       ${orderSql}
       LIMIT ? OFFSET ?`,
      [...params, currentPageSize, offset]
    );

    if (legacy === 'true') {
      return res.json(items);
    }

    return res.json({
      items,
      meta: {
        total: totalRow?.total || 0,
        page: currentPage,
        pageSize: currentPageSize,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:id/provenance', async (req, res) => {
  const { id } = req.params;

  try {
    const job = await dbGet(
      `SELECT id, company, title, source, url, first_seen_at, last_seen_at, dedup_reason, canonical_fingerprint,
              fit_score, fit_label, fit_source, fit_reason_codes, quality_bucket, rejected_by_quality, llm_confidence, llm_missing_must_have
       FROM job_queue WHERE id = ?`,
      [id]
    );
    if (!job) return res.status(404).json({ error: 'job not found' });

    const sources = await dbAll(
      `SELECT source, source_job_key, raw_post_date, normalized_post_date, ingested_at, payload_hash, run_id
       FROM job_sources
       WHERE job_id = ?
       ORDER BY ingested_at DESC`,
      [id]
    );

    const events = await dbAll(
      `SELECT id, event_type, message, payload_json, run_id, created_at
       FROM job_events
       WHERE job_id = ?
       ORDER BY id DESC
       LIMIT 100`,
      [id]
    );

    res.json({
      job,
      sources,
      events: events.map((e) => ({
        id: e.id,
        eventType: e.event_type,
        message: e.message,
        runId: e.run_id,
        createdAt: e.created_at,
        payload: (() => {
          try {
            return e.payload_json ? JSON.parse(e.payload_json) : null;
          } catch {
            return null;
          }
        })(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!isValidWorkflowStatus(status)) return res.status(400).json({ error: 'invalid status' });

  try {
    const update = await dbRun('UPDATE job_queue SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, id]);
    if (!update.changes) return res.status(404).json({ error: 'job not found' });

    await addJobEvent({
      jobId: Number(id),
      eventType: 'status_changed',
      message: `Status changed to ${status}`,
      payload: { status },
    });

    let syncWarning = null;
    if (status === 'applied') {
      try {
        await syncToPersonalDashboard(id);
        await addJobEvent({
          jobId: Number(id),
          eventType: 'synced_pd',
          message: 'Synced to personal dashboard',
        });
      } catch (err) {
        syncWarning = err.message;
        await addJobEvent({
          jobId: Number(id),
          eventType: 'sync_failed',
          message: 'Failed to sync to personal dashboard',
          payload: { error: err.message },
        });
      }
    }

    const job = await dbGet('SELECT * FROM job_queue WHERE id = ?', [id]);
    res.json({ updated: update.changes, job, syncWarning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/company/skip', async (req, res) => {
  const { company } = req.body || {};
  if (!company) return res.status(400).json({ error: 'company required' });

  try {
    const result = await dbRun(
      'UPDATE job_queue SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE company = ?',
      ['skipped', company]
    );
    res.json({ updated: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function syncToPersonalDashboard(jobId) {
  const { db: pdDB } = require('../lib/pd');
  const { sendWebhook } = require('../lib/webhook');

  const row = await dbGet('SELECT * FROM job_queue WHERE id = ?', [jobId]);
  if (!row) return;

  const notes = `Auto-synced from Job Engine. Tier ${row.tier}. Score ${row.score}. Source: ${row.source || 'unknown'}.`;

  await sendWebhook({
    company: row.company,
    position: row.title,
    status: 'applied',
    location: row.location || null,
    applied_date: new Date().toISOString().slice(0, 10),
    notes,
    url: row.url || null,
    external_id: row.id,
  });

  await new Promise((resolve, reject) => {
    pdDB.run(
      `INSERT INTO job_applications (company, position, status, location, applied_date, notes, url)
       VALUES (?, ?, 'applied', ?, date('now'), ?, ?)`,
      [row.company, row.title, row.location || null, notes, row.url || null],
      function onRun(pdErr) {
        if (pdErr) return reject(pdErr);
        resolve();
      }
    );
  });
}

module.exports = router;
