/**
 * SerpAPI Google Jobs Adapter
 *
 * Env:
 *   SERPAPI_KEY=...
 *   SERPAPI_QUERIES="software engineer toronto,backend developer toronto"
 *   SERPAPI_LOCATION="Toronto, ON, Canada"
 */

const DEFAULT_LOCATION = process.env.SERPAPI_LOCATION || 'Toronto, ON, Canada';

function buildUrl(query, location = DEFAULT_LOCATION) {
  const params = new URLSearchParams({
    engine: 'google_jobs',
    q: query,
    location,
    api_key: process.env.SERPAPI_KEY || '',
  });
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
      console.error(`[SerpAPI] API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const jobs = data.jobs_results || [];

    return jobs.map((job) => ({
      company: job.company_name || 'Unknown',
      title: job.title,
      location: job.location || null,
      post_date: job.detected_extensions?.posted_at || null,
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

module.exports = { fetchJobs, fetchAll };
