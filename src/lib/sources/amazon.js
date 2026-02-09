/**
 * Amazon Jobs Adapter (search.json)
 *
 * Example:
 * https://www.amazon.jobs/en/search.json?base_query=software%20engineer&loc_query=Toronto%2C%20ON%2C%20Canada
 */

function buildSearchUrl({ baseQuery = '', locQuery = '' }) {
  const params = new URLSearchParams();
  params.set('base_query', baseQuery || '');
  params.set('loc_query', locQuery || '');
  return `https://www.amazon.jobs/en/search.json?${params.toString()}`;
}

async function fetchJobs({ baseQuery, locQuery }) {
  const url = buildSearchUrl({ baseQuery, locQuery });
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[Amazon] API error: ${res.status}`);
      return [];
    }
    const data = await res.json();
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    return jobs.map((job) => ({
      company: 'amazon',
      title: job.title,
      location: [job.city, job.state, job.country_code].filter(Boolean).join(', ') || job.location || null,
      post_date: job.posting_date || job.updated_time || null,
      source: 'amazon',
      url: job.job_path ? `https://www.amazon.jobs${job.job_path}` : job.job_url || null,
      jd_text: job.description || job.basic_qualifications || job.preferred_qualifications || null,
      meta: {
        team: job.team || null,
        job_id: job.id || job.job_id || null,
        is_virtual: job.is_virtual || false,
      },
    }));
  } catch (err) {
    console.error('[Amazon] Fetch failed:', err.message);
    return [];
  }
}

async function fetchAll({ baseQueries = [], locQueries = [] }) {
  const queries = baseQueries.length ? baseQueries : [''];
  const locs = locQueries.length ? locQueries : [''];
  const tasks = [];
  for (const q of queries) {
    for (const loc of locs) {
      tasks.push(fetchJobs({ baseQuery: q, locQuery: loc }));
    }
  }
  const results = await Promise.all(tasks);
  return results.flat();
}

module.exports = { fetchJobs, fetchAll };
