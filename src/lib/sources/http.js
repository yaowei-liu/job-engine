const BROWSER_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

async function fetchJson(url, extra = {}) {
  try {
    const res = await fetch(url, {
      ...extra,
      headers: { ...BROWSER_HEADERS, ...(extra.headers || {}) },
    });
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('json')) {
      return { ok: false, status: res.status, data: null, contentType, error: 'non_json_response' };
    }
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data, contentType, error: null };
  } catch (err) {
    return { ok: false, status: 0, data: null, contentType: '', error: err.message || 'request_failed' };
  }
}

async function fetchText(url, extra = {}) {
  try {
    const res = await fetch(url, {
      ...extra,
      headers: { ...BROWSER_HEADERS, ...(extra.headers || {}) },
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err.message || 'request_failed' };
  }
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseJsonFromScriptTag(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractScriptBlocks(html = '') {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = re.exec(html);
  while (match) {
    blocks.push(match[1] || '');
    match = re.exec(html);
  }
  return blocks;
}

function flattenJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (Array.isArray(node['@graph'])) {
    flattenJsonLd(node['@graph'], out);
    return out;
  }
  out.push(node);
  return out;
}

function locationFromJobPosting(posting = {}) {
  const loc = posting.jobLocation;
  if (!loc) return null;
  const nodes = Array.isArray(loc) ? loc : [loc];
  for (const n of nodes) {
    const address = n?.address || {};
    const parts = [
      address.addressLocality,
      address.addressRegion,
      address.addressCountry,
    ].filter(Boolean);
    if (parts.length) return parts.join(', ');
  }
  return null;
}

function parseJobPostingsFromHtml(html = '') {
  const blocks = extractScriptBlocks(html);
  const postings = [];
  for (const raw of blocks) {
    const parsed = parseJsonFromScriptTag(raw);
    if (!parsed) continue;
    const nodes = flattenJsonLd(parsed);
    for (const node of nodes) {
      const t = node?.['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (!types.some((x) => String(x || '').toLowerCase() === 'jobposting')) continue;
      postings.push(node);
    }
  }
  return postings;
}

module.exports = {
  BROWSER_HEADERS,
  fetchJson,
  fetchText,
  stripHtml,
  parseJobPostingsFromHtml,
  locationFromJobPosting,
};
