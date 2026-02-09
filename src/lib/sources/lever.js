/**
 * Lever Job Board Adapter
 *
 * Usage:
 *   const { fetchJobs } = require('./sources/lever');
 *   const jobs = await fetchJobs('https://jobs.lever.co/companyname');
 */

const DEFAULT_BOARDS = [
  // Add target Lever boards here
  // 'https://jobs.lever.co/companyname',
];

function extractCompanySlug(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('lever.co')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch {
    return null;
  }
}

async function fetchJobs(boardUrl) {
  const company = extractCompanySlug(boardUrl);
  if (!company) {
    console.error(`[Lever] Invalid board URL: ${boardUrl}`);
    return [];
  }

  const apiUrl = `https://api.lever.co/v0/postings/${company}?mode=json`;

  try {
    const res = await fetch(apiUrl);
    if (!res.ok) {
      console.error(`[Lever] API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    const jobs = data.map((job) => ({
      company,
      title: job.text,
      location: job.categories?.location || null,
      post_date: job.createdAt ? new Date(job.createdAt).toISOString().slice(0, 10) : null,
      source: 'lever',
      url: job.hostedUrl || job.applyUrl || null,
      jd_text: job.descriptionPlain || job.description?.replace(/<[^>]*>/g, '').slice(0, 2000) || null,
    }));

    console.log(`[Lever] Fetched ${jobs.length} jobs from ${company}`);
    return jobs;
  } catch (err) {
    console.error(`[Lever] Failed to fetch ${boardUrl}:`, err.message);
    return [];
  }
}

async function fetchAll(boardUrls = DEFAULT_BOARDS) {
  const results = await Promise.all(boardUrls.map((url) => fetchJobs(url).catch(() => [])));
  return results.flat();
}

module.exports = { fetchJobs, fetchAll, DEFAULT_BOARDS, extractCompanySlug };
