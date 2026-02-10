const DEFAULT_TARGETS = [];
const { fetchJson, fetchText, stripHtml, parseJobPostingsFromHtml, locationFromJobPosting } = require('./http');

function normalizeDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function extractAccount(target) {
  if (!target) return null;
  const raw = String(target).trim();
  if (!raw) return null;
  if (!raw.includes('://')) return raw;
  try {
    const u = new URL(raw);
    if (!u.hostname.endsWith('workable.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.hostname.startsWith('apply.workable.com')) return parts[0] || null;
    return parts[0] || null;
  } catch {
    return null;
  }
}

function toLocation(job = {}) {
  const location = job.location || {};
  const parts = [location.city, location.region, location.country].filter(Boolean);
  return parts.join(', ') || job.location?.location_str || null;
}

function mapJobs(account, rows = []) {
  return rows
    .filter((j) => j?.title)
    .map((job) => ({
      company: account,
      title: job.title,
      location: toLocation(job),
      post_date: normalizeDate(job.published || job.created_at || job.updated_at),
      source: 'workable',
      url: job.url || (job.shortcode ? `https://apply.workable.com/${account}/j/${job.shortcode}/` : null),
      jd_text: stripHtml(job.description || job.requirements || '').slice(0, 2000) || null,
      meta: {
        workable_id: job.id || job.shortcode || null,
      },
    }));
}

async function fetchFromApiV3(account) {
  const apiUrl = `https://apply.workable.com/api/v3/accounts/${account}/jobs?state=published&limit=100`;
  const { ok, data } = await fetchJson(apiUrl);
  if (!ok || !data) return null;
  const rows = Array.isArray(data?.results) ? data.results : (Array.isArray(data?.jobs) ? data.jobs : []);
  return mapJobs(account, rows);
}

async function fetchFromApiV1(account) {
  const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${account}/jobs`;
  const { ok, data } = await fetchJson(apiUrl);
  if (!ok || !data) return null;
  const rows = Array.isArray(data?.jobs) ? data.jobs : (Array.isArray(data?.results) ? data.results : []);
  return mapJobs(account, rows);
}

async function fetchFromPublicPage(account) {
  const pageUrl = `https://apply.workable.com/${account}`;
  const { ok, text } = await fetchText(pageUrl);
  if (!ok || !text) return [];
  const postings = parseJobPostingsFromHtml(text);
  return postings
    .filter((p) => p?.title)
    .map((p) => ({
      company: account,
      title: p.title,
      location: locationFromJobPosting(p) || null,
      post_date: normalizeDate(p.datePosted || p.validFrom),
      source: 'workable',
      url: p.url || null,
      jd_text: stripHtml(p.description || '').slice(0, 2000) || null,
      meta: {
        workable_id: p.identifier?.value || p.identifier || null,
      },
    }));
}

async function fetchJobs(target) {
  const account = extractAccount(target);
  if (!account) {
    console.error(`[Workable] Invalid target: ${target}`);
    return [];
  }

  try {
    const v3 = await fetchFromApiV3(account);
    if (Array.isArray(v3)) {
      console.log(`[Workable] Fetched ${v3.length} jobs from ${account} (v3)`);
      return v3;
    }
    const v1 = await fetchFromApiV1(account);
    if (Array.isArray(v1)) {
      console.log(`[Workable] Fetched ${v1.length} jobs from ${account} (v1)`);
      return v1;
    }
    const page = await fetchFromPublicPage(account);
    if (Array.isArray(page) && page.length) {
      console.log(`[Workable] Fetched ${page.length} jobs from ${account} (html)`);
      return page;
    }
    return [];
  } catch (err) {
    console.error(`[Workable] Failed to fetch ${account}:`, err.message);
    return [];
  }
}

async function fetchAll(targets = DEFAULT_TARGETS) {
  const results = await Promise.all((targets || []).map((t) => fetchJobs(t).catch(() => [])));
  return results.flat();
}

module.exports = {
  DEFAULT_TARGETS,
  extractAccount,
  fetchAll,
  fetchJobs,
};
