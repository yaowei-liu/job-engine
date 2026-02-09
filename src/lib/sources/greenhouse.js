/**
 * Greenhouse Job Board Adapter
 * Fetches live jobs from Greenhouse boards.
 *
 * Usage:
 *   const { fetchJobs } = require('./sources/greenhouse');
 *   const jobs = await fetchJobs('https://boards.greenhouse.io/companyname');
 */

const DEFAULT_BOARDS = [
  // Add your target companies here
  // 'https://boards.greenhouse.io/lever',
  // 'https://boards.greenhouse.io/ashby',
];

/**
 * Extract board token from Greenhouse URL
 * @param {string} url
 * @returns {string|null}
 */
function extractBoardToken(url) {
  const match = url.match(/boards\.greenhouse\.io\/([A-Za-z0-9-]+)/);
  return match ? match[1] : null;
}

/**
 * Fetch jobs from a Greenhouse board
 * @param {string} boardUrl
 * @returns {Promise<Array>}
 */
async function fetchJobs(boardUrl) {
  const token = extractBoardToken(boardUrl);
  if (!token) {
    console.error(`[Greenhouse] Invalid board URL: ${boardUrl}`);
    return [];
  }

  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;

  try {
    const res = await fetch(apiUrl);
    if (!res.ok) {
      console.error(`[Greenhouse] API error: ${res.status}`);
      return [];
    }

    const data = await res.json();

    if (!data.jobs || !Array.isArray(data.jobs)) {
      console.warn(`[Greenhouse] No jobs found for ${boardUrl}`);
      return [];
    }

    const jobs = data.jobs.map(job => ({
      company: token,
      title: job.title,
      location: job.location?.name || null,
      post_date: job.updated_at?.slice(0, 10) || null,
      source: 'greenhouse',
      url: job.absolute_url,
      jd_text: job.content?.replace(/<[^>]*>/g, '').slice(0, 2000) || null,
    }));

    console.log(`[Greenhouse] Fetched ${jobs.length} jobs from ${token}`);
    return jobs;
  } catch (err) {
    console.error(`[Greenhouse] Failed to fetch ${boardUrl}:`, err.message);
    return [];
  }
}

/**
 * Fetch from multiple boards
 * @param {string[]} boardUrls
 * @returns {Promise<Array>}
 */
async function fetchAll(boardUrls = DEFAULT_BOARDS) {
  const results = await Promise.all(boardUrls.map(url => fetchJobs(url).catch(() => [])));
  return results.flat();
}

module.exports = { fetchJobs, fetchAll, DEFAULT_BOARDS };
