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
    if (!u.hostname.endsWith('bamboohr.com')) return null;
    return u.hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

async function fetchJobs(target) {
  const company = extractCompany(target);
  if (!company) {
    console.error(`[BambooHR] Invalid target: ${target}`);
    return [];
  }

  const endpoints = [
    `https://${company}.bamboohr.com/careers/list?output=json`,
    `https://${company}.bamboohr.com/jobs/?source=bamboohr&output=json`,
  ];

  for (const apiUrl of endpoints) {
    const { ok, data } = await fetchJson(apiUrl);
    if (!ok || !data) continue;
    const rows = Array.isArray(data?.jobs)
      ? data.jobs
      : (Array.isArray(data?.openings)
        ? data.openings
        : (Array.isArray(data?.result)
          ? data.result
          : (Array.isArray(data) ? data : [])));
    const jobs = rows
      .filter((j) => j?.jobOpeningName || j?.title)
      .map((job) => ({
        company,
        title: job.jobOpeningName || job.title,
        location: job.location || job.departmentLabel || null,
        post_date: normalizeDate(job.date || job.datePublished || job.created || job.postedDate),
        source: 'bamboohr',
        url: job.jobOpeningUrl || job.url || null,
        jd_text: stripHtml(job.description || job.descriptionLabel || '').slice(0, 2000) || null,
        meta: {
          bamboohr_id: job.id || job.jobOpeningId || null,
        },
      }));
    console.log(`[BambooHR] Fetched ${jobs.length} jobs from ${company}`);
    return jobs;
  }

  const pageUrl = `https://${company}.bamboohr.com/careers`;
  const { ok: pageOk, text } = await fetchText(pageUrl);
  if (pageOk && text) {
    const postings = parseJobPostingsFromHtml(text);
    const jobs = postings
      .filter((p) => p?.title)
      .map((p) => ({
        company,
        title: p.title,
        location: locationFromJobPosting(p) || null,
        post_date: normalizeDate(p.datePosted || p.validFrom),
        source: 'bamboohr',
        url: p.url || null,
        jd_text: stripHtml(p.description || '').slice(0, 2000) || null,
        meta: { bamboohr_id: p.identifier?.value || p.identifier || null },
      }));
    if (jobs.length) {
      console.log(`[BambooHR] Fetched ${jobs.length} jobs from ${company} (html)`);
      return jobs;
    }
  }

  console.error(`[BambooHR] Failed to fetch ${company}`);
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
