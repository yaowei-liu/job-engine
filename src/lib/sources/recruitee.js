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
    if (u.hostname === 'jobs.recruitee.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      return parts[0] || null;
    }
    if (u.hostname.endsWith('.recruitee.com')) return u.hostname.split('.')[0];
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch {
    return null;
  }
}

function toLocation(offer = {}) {
  const city = offer.city || offer.location || null;
  const country = offer.country || null;
  return [city, country].filter(Boolean).join(', ') || null;
}

async function fetchJobs(target) {
  const company = extractCompany(target);
  if (!company) {
    console.error(`[Recruitee] Invalid target: ${target}`);
    return [];
  }

  const aliases = Array.from(new Set([company, company.replace(/-/g, '')].filter(Boolean)));
  const endpoints = [];
  for (const alias of aliases) {
    endpoints.push(
      `https://${alias}.recruitee.com/api/offers/`,
      `https://${alias}.recruitee.com/api/offers/?limit=200`,
      `https://jobs.recruitee.com/api/offers/?company=${encodeURIComponent(alias)}`,
      `https://jobs.recruitee.com/api/offers?company=${encodeURIComponent(alias)}`
    );
  }

  for (const apiUrl of endpoints) {
    const { ok, data } = await fetchJson(apiUrl);
    if (!ok || !data) continue;
    const offers = Array.isArray(data?.offers) ? data.offers : (Array.isArray(data) ? data : []);
    const jobs = offers
      .filter((o) => o?.title)
      .map((offer) => ({
        company,
        title: offer.title,
        location: toLocation(offer),
        post_date: normalizeDate(offer.created_at || offer.published_at || offer.updated_at),
        source: 'recruitee',
        url: offer.careers_url || offer.url || (offer.id ? `https://${company}.recruitee.com/o/${offer.id}` : null),
        jd_text: stripHtml(offer.description || offer.description_html || '').slice(0, 2000) || null,
        meta: {
          recruitee_id: offer.id || null,
        },
      }));
    console.log(`[Recruitee] Fetched ${jobs.length} jobs from ${company}`);
    return jobs;
  }

  const pageUrl = `https://jobs.recruitee.com/${company}`;
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
        source: 'recruitee',
        url: p.url || null,
        jd_text: stripHtml(p.description || '').slice(0, 2000) || null,
        meta: { recruitee_id: p.identifier?.value || p.identifier || null },
      }));
    if (jobs.length) {
      console.log(`[Recruitee] Fetched ${jobs.length} jobs from ${company} (html)`);
      return jobs;
    }
  }

  console.error(`[Recruitee] Failed to fetch ${company}`);
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
