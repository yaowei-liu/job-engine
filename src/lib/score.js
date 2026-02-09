const fs = require('fs');
const path = require('path');

function loadRules() {
  const p = path.join(__dirname, 'rules.default.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function countOccurrences(text, keyword) {
  if (!text || !keyword) return 0;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'gi');
  return (text.match(regex) || []).length;
}

function scoreJD(jdText, postDateIso, titleText = '') {
  const rules = loadRules();
  const text = (jdText || '').toLowerCase();
  const title = (titleText || '').toLowerCase();

  let score = 0;
  let tier = 'B';
  const hits = [];

  const titleBoost = rules.titleBoost || 2;
  const maxHits = rules.maxKeywordHits || 5;

  // Tier A match
  for (const [kw, w] of Object.entries(rules.tiers.A.keywords)) {
    const count = countOccurrences(text, kw);
    if (count > 0) {
      score += Math.min(count, maxHits) * w;
      if (title.includes(kw)) score += w * titleBoost;
      hits.push(`+A:${kw}x${count}`);
      tier = 'A';
    }
  }

  // Tier B match
  for (const [kw, w] of Object.entries(rules.tiers.B.keywords)) {
    const count = countOccurrences(text, kw);
    if (count > 0) {
      score += Math.min(count, maxHits) * w;
      if (title.includes(kw)) score += w * titleBoost;
      hits.push(`+B:${kw}x${count}`);
    }
  }

  // Negatives
  for (const [kw, w] of Object.entries(rules.negative)) {
    const count = countOccurrences(text, kw);
    if (count > 0) {
      score -= Math.min(count, maxHits) * w;
      if (title.includes(kw)) score -= w * titleBoost;
      hits.push(`-:${kw}x${count}`);
    }
  }

  // Freshness
  if (postDateIso) {
    const ageMs = Date.now() - new Date(postDateIso).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours <= 24) { score += rules.freshness.hours24; hits.push('+fresh:24h'); }
    else if (ageHours <= 24*7) { score += rules.freshness.days7; hits.push('+fresh:7d'); }
  }

  // Hard filter for senior roles (title-focused)
  const hardFilters = ['senior', 'lead', 'staff', 'principal', 'manager'];
  if (hardFilters.some((kw) => title.includes(kw))) {
    score -= 100;
    tier = 'C';
    hits.push('hard:senior-title');
  }

  return { score, tier, hits };
}

module.exports = { scoreJD };
