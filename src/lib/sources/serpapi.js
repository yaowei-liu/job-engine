const SERPAPI_KEY = process.env.SERPAPI_KEY;

async function fetchSerpJobs(query, location = 'Canada', freshness = 'day') {
  if (!SERPAPI_KEY) throw new Error('SERPAPI_KEY missing');
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_jobs');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en');
  url.searchParams.set('location', location);
  url.searchParams.set('api_key', SERPAPI_KEY);
  if (freshness === 'day') url.searchParams.set('tbs', 'qdr:d');
  if (freshness === 'week') url.searchParams.set('tbs', 'qdr:w');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`SerpApi fetch failed: ${res.status}`);
  const data = await res.json();
  return data.jobs_results || [];
}

module.exports = { fetchSerpJobs };
