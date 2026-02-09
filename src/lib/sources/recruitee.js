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

function extractCompany(target) {
  if (!target) return null;
  const raw = String(target).trim();
  if (!raw) return null;
  if (!raw.includes('://')) return raw;
  try {
    const u = new URL(raw);
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

  const endpoints = [
    `https://${company}.recruitee.com/api/offers/`,
    `https://${company}.recruitee.com/api/offers/?limit=200`,
  ];

  for (const apiUrl of endpoints) {
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) continue;
      const data = await res.json();
      const offers = Array.isArray(data?.offers) ? data.offers : [];
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
    } catch {
      // try next endpoint
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

