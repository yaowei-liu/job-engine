/**
 * SerpAPI Google Jobs Adapter
 *
 * Env:
 *   SERPAPI_KEY=...
 *   SERPAPI_QUERIES="software engineer toronto,backend developer toronto"
 *   SERPAPI_LOCATION="Toronto, Ontario, Canada"
 */

const DEFAULT_LOCATION = process.env.SERPAPI_LOCATION || '';

function normalizePostedAt(postedAt) {
  if (!postedAt) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(postedAt)) return postedAt.slice(0, 10);

  const lower = postedAt.toLowerCase();
  const now = new Date();

  if (lower.includes('today')) return now.toISOString().slice(0, 10);
  if (lower.includes('yesterday')) {
    const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  const match = lower.match(/(\d+)\s*(hour|day|week|month|year)s?\s*ago/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const msMap = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };

  const delta = msMap[unit] ? msMap[unit] * value : 0;
  if (!delta) return null;

  return new Date(now.getTime() - delta).toISOString().slice(0, 10);
}

function isGoogleUrl(link) {
  try {
    const u = new URL(link);
    return u.hostname.endsWith('google.com') || u.hostname.endsWith('google.ca') || u.hostname.endsWith('google.co.uk') || u.hostname.includes('.google.');
  } catch {
    return false;
  }
}

function pickDirectUrl(job) {
  const apply = job.apply_options || [];
  const direct = apply.find((opt) => opt?.link && !isGoogleUrl(opt.link));
  if (direct?.link) return direct.link;

  const related = (job.related_links || []).find((opt) => opt?.link && !isGoogleUrl(opt.link));
  if (related?.link) return related.link;

  return job.related_links?.[0]?.link || job.share_link || null;
}

function fetchJobs(query, location = DEFAULT_LOCATION) {
  if (!process.env.SERPAPI_KEY) {
    console.warn('[SerpAPI] Missing SERPAPI_KEY');
    return Promise.resolve([]);
  }

  let getJson;
  try {
    ({ getJson } = require('serpapi'));
  } catch {
    console.warn('[SerpAPI] Missing serpapi package; run npm install');
    return Promise.resolve([]);
  }

  const params = {
    engine: 'google_jobs',
    q: query,
    google_domain: process.env.SERPAPI_DOMAIN || 'google.ca',
    hl: process.env.SERPAPI_HL || 'en',
    gl: process.env.SERPAPI_GL || 'ca',
    api_key: process.env.SERPAPI_KEY,
  };

  if (location && location.trim()) params.location = location.trim();

  return new Promise((resolve) => {
    try {
      getJson(params, (json) => {
        if (json?.error) {
          console.error('[SerpAPI] API error:', json.error);
          return resolve([]);
        }

        const jobs = json?.jobs_results || [];
        const mapped = jobs.map((job) => ({
          company: job.company_name || 'Unknown',
          title: job.title,
          location: job.location || null,
          post_date: normalizePostedAt(job.detected_extensions?.posted_at) || null,
          source: 'serpapi',
          url: pickDirectUrl(job),
          jd_text: job.description?.slice(0, 2000) || null,
        }));

        resolve(mapped);
      });
    } catch (err) {
      console.error('[SerpAPI] SDK error:', err.message);
      resolve([]);
    }
  });
}

async function fetchAll(queries = [], location) {
  const out = await fetchAllWithStats(queries, location);
  return out.jobs;
}

async function fetchAllWithStats(queries = [], location, options = {}) {
  const concurrency = Math.min(Math.max(parseInt(options.concurrency || '3', 10), 1), 10);
  const safeQueries = Array.isArray(queries) ? queries : [];
  const jobs = [];
  let index = 0;
  let failed = 0;
  let empty = 0;
  let succeeded = 0;

  const workers = Array.from({ length: Math.min(concurrency, safeQueries.length) }, async () => {
    while (index < safeQueries.length) {
      const current = safeQueries[index];
      index += 1;
      try {
        const result = await fetchJobs(current, location);
        if (!result.length) {
          empty += 1;
        } else {
          succeeded += 1;
          jobs.push(...result);
        }
      } catch {
        failed += 1;
      }
    }
  });

  await Promise.all(workers);
  return {
    jobs,
    stats: {
      attempted: safeQueries.length,
      succeeded,
      failed,
      empty,
    },
  };
}

module.exports = { fetchJobs, fetchAll, fetchAllWithStats, normalizePostedAt, pickDirectUrl };
