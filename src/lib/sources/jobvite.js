const DEFAULT_TARGETS = [];
const { fetchJson, fetchText, stripHtml, parseJobPostingsFromHtml, locationFromJobPosting } = require('./http');

function normalizeDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function extractCompany(target) {
  if (!target) return null;
  const raw = String(target).trim();
  if (!raw) return null;
  if (!raw.includes('://')) return raw;
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith('jobvite.com')) {
      const sub = u.hostname.split('.')[0];
      if (sub && sub !== 'jobs') return sub;
      const parts = u.pathname.split('/').filter(Boolean);
      return parts[0] || null;
    }
    return null;
  } catch {
    return null;
  }
}

function mapJob(company, job = {}) {
  return {
    company,
    title: job.title || job.jobTitle || null,
    location: job.location || job.jobLocation || null,
    post_date: normalizeDate(job.postDate || job.postedDate || job.createdDate),
    source: 'jobvite',
    url: job.applyUrl || job.url || null,
    jd_text: stripHtml(job.description || job.jobDescription || '').slice(0, 2000) || null,
    meta: {
      jobvite_id: job.id || job.jobId || null,
    },
  };
}

async function fetchJobs(target) {
  const company = extractCompany(target);
  if (!company) {
    console.error(`[Jobvite] Invalid target: ${target}`);
    return [];
  }

  const endpoints = [
    `https://jobs.jobvite.com/api/v1/job?company=${company}`,
    `https://jobs.jobvite.com/api/v1/job/${company}`,
    `https://jobs.jobvite.com/api/job/v1/${company}`,
  ];

  for (const apiUrl of endpoints) {
    const { ok, data } = await fetchJson(apiUrl);
    if (!ok || !data) continue;
    const rows = Array.isArray(data?.jobs)
      ? data.jobs
      : (Array.isArray(data?.requisitions)
        ? data.requisitions
        : (Array.isArray(data) ? data : []));
    const jobs = rows
      .map((job) => mapJob(company, job))
      .filter((j) => j.title);
    console.log(`[Jobvite] Fetched ${jobs.length} jobs from ${company}`);
    return jobs;
  }

  const pageCandidates = [
    `https://jobs.jobvite.com/${company}/jobs`,
    `https://jobs.jobvite.com/${company}`,
  ];
  for (const pageUrl of pageCandidates) {
    const { ok: pageOk, text } = await fetchText(pageUrl);
    if (!pageOk || !text) continue;
    const postings = parseJobPostingsFromHtml(text);
    const jobs = postings
      .filter((p) => p?.title)
      .map((p) => ({
        company,
        title: p.title,
        location: locationFromJobPosting(p) || null,
        post_date: normalizeDate(p.datePosted || p.validFrom),
        source: 'jobvite',
        url: p.url || null,
        jd_text: stripHtml(p.description || '').slice(0, 2000) || null,
        meta: { jobvite_id: p.identifier?.value || p.identifier || null },
      }));
    if (jobs.length) {
      console.log(`[Jobvite] Fetched ${jobs.length} jobs from ${company} (html)`);
      return jobs;
    }
  }

  console.error(`[Jobvite] Failed to fetch ${company}`);
  return [];
}

async function fetchAll(targets = DEFAULT_TARGETS) {
  const results = await Promise.all((targets || []).map((t) => fetchJobs(t).catch(() => [])));
  return results.flat();
}

module.exports = {
  DEFAULT_TARGETS,
  extractCompany,
  fetchAll,
  fetchJobs,
};
