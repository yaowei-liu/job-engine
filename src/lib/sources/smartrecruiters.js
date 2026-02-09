const DEFAULT_TARGETS = [];

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function extractCompanyIdentifier(target) {
  if (!target) return null;
  const raw = String(target).trim();
  if (!raw) return null;
  if (!raw.includes('://')) return raw;
  try {
    const u = new URL(raw);
    if (!u.hostname.endsWith('smartrecruiters.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch {
    return null;
  }
}

function toLocation(posting) {
  const loc = posting?.location || {};
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  return parts.join(', ') || loc.remote || null;
}

function toPostingUrl(company, posting = {}) {
  if (typeof posting.ref === 'string' && /^https?:\/\//i.test(posting.ref)) return posting.ref;
  const id = posting.id || posting.uuid || posting.ref || null;
  return id ? `https://jobs.smartrecruiters.com/${company}/${id}` : null;
}

async function fetchJobs(target) {
  const company = extractCompanyIdentifier(target);
  if (!company) {
    console.error(`[SmartRecruiters] Invalid target: ${target}`);
    return [];
  }

  const all = [];
  const limit = 100;
  for (let offset = 0; offset < 500; offset += limit) {
    const apiUrl = `https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=${limit}&offset=${offset}`;
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) {
        console.error(`[SmartRecruiters] API error ${res.status} for ${company}`);
        break;
      }
      const data = await res.json();
      const rows = Array.isArray(data?.content) ? data.content : [];
      if (!rows.length) break;
      all.push(...rows);
      if (rows.length < limit) break;
    } catch (err) {
      console.error(`[SmartRecruiters] Failed to fetch ${company}:`, err.message);
      break;
    }
  }

  const jobs = all
    .filter((p) => p?.name)
    .map((posting) => ({
      company,
      title: posting.name,
      location: toLocation(posting),
      post_date: normalizeDate(posting.releasedDate || posting.createdOn || posting.updatedDate),
      source: 'smartrecruiters',
      url: toPostingUrl(company, posting),
      jd_text: stripHtml(posting?.jobAd?.sections?.jobDescription?.text || posting?.jobAd?.summary || '').slice(0, 2000) || null,
      meta: {
        smartrecruiters_id: posting.id || posting.uuid || null,
      },
    }));

  console.log(`[SmartRecruiters] Fetched ${jobs.length} jobs from ${company}`);
  return jobs;
}

async function fetchAll(targets = DEFAULT_TARGETS) {
  const results = await Promise.all((targets || []).map((t) => fetchJobs(t).catch(() => [])));
  return results.flat();
}

module.exports = {
  DEFAULT_TARGETS,
  extractCompanyIdentifier,
  fetchAll,
  fetchJobs,
};

