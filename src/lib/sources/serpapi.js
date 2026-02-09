/**
 * SerpAPI Google Jobs Adapter
 *
 * Env:
 *   SERPAPI_KEY=...
 *   SERPAPI_QUERIES="software engineer toronto,backend developer toronto"
 *   SERPAPI_LOCATION="Toronto, ON, Canada"
 */

const DEFAULT_LOCATION = process.env.SERPAPI_LOCATION || 'Toronto, ON, Canada';

function normalizePostedAt(postedAt) {
  if (!postedAt) return null;
  // If already ISO-like (YYYY-MM-DD), keep it
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

function buildUrl(query, location = DEFAULT_LOCATION) {
  const params = new URLSearchParams({
    engine: 'google_jobs',
    q: query,
    google_domain: process.env.SERPAPI_DOMAIN || 'google.ca',
    hl: process.env.SERPAPI_HL || 'en',
    gl: process.env.SERPAPI_GL || 'ca',
    api_key: process.env.SERPAPI_KEY || '',
  });

  if (location) params.set('location', location);

  return `https://serpapi.com/search.json?${params.toString()}`;
}

async function fetchJobs(query, location) {
  if (!process.env.SERPAPI_KEY) {
    console.warn('[SerpAPI] Missing SERPAPI_KEY');
    return [];
  }

  const url = buildUrl(query, location);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[SerpAPI] API error: ${res.status} ${errText}`);
      return [];
    }

    const data = await res.json();
    const jobs = data.jobs_results || [];

    return jobs.map((job) => ({
      company: job.company_name || 'Unknown',
      title: job.title,
      location: job.location || null,
      post_date: normalizePostedAt(job.detected_extensions?.posted_at) || null,
      source: 'serpapi',
      url: job.related_links?.[0]?.link || job.share_link || null,
      jd_text: job.description?.slice(0, 2000) || null,
    }));
  } catch (err) {
    console.error('[SerpAPI] Fetch failed:', err.message);
    return [];
  }
}

async function fetchAll(queries = [], location) {
  const results = await Promise.all(
    queries.map((q) => fetchJobs(q, location).catch(() => []))
  );
  return results.flat();
}

module.exports = { fetchJobs, fetchAll, normalizePostedAt };
