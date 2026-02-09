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

function decodeGoogleRedirectUrl(link) {
  try {
    const u = new URL(link);
    if (!isGoogleUrl(link)) return null;
    const candidate = u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('adurl');
    if (!candidate) return null;
    const decoded = decodeURIComponent(candidate);
    if (!/^https?:\/\//i.test(decoded)) return null;
    if (isGoogleUrl(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function findBestLink(candidates = [], sourceLabel = 'unknown') {
  for (const item of candidates) {
    const link = item?.link;
    if (!link) continue;
    if (!isGoogleUrl(link)) {
      return { url: link, resolution: 'direct', source: sourceLabel };
    }
  }
  for (const item of candidates) {
    const link = item?.link;
    if (!link) continue;
    const decoded = decodeGoogleRedirectUrl(link);
    if (decoded) {
      return { url: decoded, resolution: 'decoded_redirect', source: sourceLabel };
    }
  }
  return null;
}

function resolveJobUrl(job) {
  const apply = findBestLink(job.apply_options || [], 'apply_options');
  if (apply) return apply;
  const related = findBestLink(job.related_links || [], 'related_links');
  if (related) return related;

  if (job.share_link && !isGoogleUrl(job.share_link)) {
    return { url: job.share_link, resolution: 'direct', source: 'share_link' };
  }
  const decodedShare = job.share_link ? decodeGoogleRedirectUrl(job.share_link) : null;
  if (decodedShare) {
    return { url: decodedShare, resolution: 'decoded_redirect', source: 'share_link' };
  }

  return { url: null, resolution: 'unavailable', source: 'none' };
}

function pickDirectUrl(job) {
  return resolveJobUrl(job).url;
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
        const mapped = jobs.map((job) => {
          const resolved = resolveJobUrl(job);
          return {
            company: job.company_name || 'Unknown',
            title: job.title,
            location: job.location || null,
            post_date: normalizePostedAt(job.detected_extensions?.posted_at) || null,
            source: 'serpapi',
            url: resolved.url,
            jd_text: job.description?.slice(0, 2000) || null,
            meta: {
              url_resolution: resolved.resolution,
              url_source: resolved.source,
            },
          };
        });

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
  let directUrlCount = 0;
  let decodedUrlCount = 0;
  let missingUrlCount = 0;

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
          for (const job of result) {
            const kind = job?.meta?.url_resolution || (job?.url ? 'direct' : 'unavailable');
            if (kind === 'decoded_redirect') decodedUrlCount += 1;
            else if (kind === 'direct') directUrlCount += 1;
            else missingUrlCount += 1;
          }
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
      directUrlCount,
      decodedUrlCount,
      missingUrlCount,
    },
  };
}

module.exports = { fetchJobs, fetchAll, fetchAllWithStats, normalizePostedAt, pickDirectUrl };
