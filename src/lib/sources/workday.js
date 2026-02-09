const DEFAULT_TARGETS = [];

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

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
  if (!match) {
    const parsed = new Date(postedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const msMap = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };
  const delta = (msMap[unit] || 0) * value;
  if (!delta) return null;
  return new Date(now.getTime() - delta).toISOString().slice(0, 10);
}

function extractWorkdayConfig(target) {
  try {
    const u = new URL(target);
    const parts = u.pathname.split('/').filter(Boolean);
    const tenant = u.hostname.split('.')[0];
    const localePattern = /^[a-z]{2}(?:-[a-z]{2})?$/i;
    const site = parts[0] && localePattern.test(parts[0]) ? parts[1] : parts[0];
    if (!tenant || !site) return null;
    const apiUrl = `${u.origin}/wday/cxs/${tenant}/${site}/jobs`;
    return { tenant, site, apiUrl, origin: u.origin };
  } catch {
    return null;
  }
}

async function fetchJobs(boardUrl, options = {}) {
  const cfg = extractWorkdayConfig(boardUrl);
  if (!cfg) {
    console.error(`[Workday] Invalid board URL: ${boardUrl}`);
    return [];
  }

  const pageSize = Math.min(Math.max(parseInt(options.pageSize || '20', 10), 1), 20);
  const maxPages = Math.min(Math.max(parseInt(options.maxPages || '5', 10), 1), 20);
  const jobs = [];

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    try {
      const res = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appliedFacets: {},
          limit: pageSize,
          offset,
          searchText: '',
        }),
      });

      if (!res.ok) {
        console.error(`[Workday] API error ${res.status} for ${cfg.site}`);
        break;
      }

      const data = await res.json();
      const postings = Array.isArray(data?.jobPostings) ? data.jobPostings : [];
      if (!postings.length) break;

      for (const posting of postings) {
        jobs.push({
          company: cfg.tenant,
          title: posting.title || null,
          location: posting.locationsText || posting.location || null,
          post_date: normalizePostedAt(posting.postedOn || posting.bulletFields?.[0] || posting.publishedDate),
          source: 'workday',
          url: posting.externalPath ? `${cfg.origin}${posting.externalPath}` : null,
          jd_text: stripHtml(posting.description || posting.shortDescription || '').slice(0, 2000) || null,
          meta: {
            workday_id: posting.bulletFields?.find((v) => typeof v === 'string' && v.includes('R')) || null,
            tenant: cfg.tenant,
            site: cfg.site,
          },
        });
      }

      if (postings.length < pageSize) break;
    } catch (err) {
      console.error(`[Workday] Failed to fetch ${cfg.site}:`, err.message);
      break;
    }
  }

  const filtered = jobs.filter((j) => j.title);
  console.log(`[Workday] Fetched ${filtered.length} jobs from ${cfg.site}`);
  return filtered;
}

async function fetchAll(boardUrls = DEFAULT_TARGETS) {
  const results = await Promise.all(boardUrls.map((url) => fetchJobs(url).catch(() => [])));
  return results.flat();
}

module.exports = {
  DEFAULT_TARGETS,
  extractWorkdayConfig,
  fetchAll,
  fetchJobs,
  normalizePostedAt,
};
