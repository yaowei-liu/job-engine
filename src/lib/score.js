const fs = require('fs');
const path = require('path');

function loadRules() {
  const p = path.join(__dirname, 'rules.default.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function scoreJD(jdText, postDateIso) {
  const rules = loadRules();
  const text = (jdText || '').toLowerCase();

  let score = 0;
  let tier = 'B';
  const hits = [];

  // Tier A match
  for (const [kw, w] of Object.entries(rules.tiers.A.keywords)) {
    if (text.includes(kw)) { score += w; hits.push(`+A:${kw}`); tier = 'A'; }
  }

  // Tier B match
  for (const [kw, w] of Object.entries(rules.tiers.B.keywords)) {
    if (text.includes(kw)) { score += w; hits.push(`+B:${kw}`); }
  }

  // Negatives
  for (const [kw, w] of Object.entries(rules.negative)) {
    if (text.includes(kw)) { score -= w; hits.push(`-:${kw}`); }
  }

  // Freshness
  if (postDateIso) {
    const ageMs = Date.now() - new Date(postDateIso).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours <= 24) { score += rules.freshness.hours24; hits.push('+fresh:24h'); }
    else if (ageHours <= 24*7) { score += rules.freshness.days7; hits.push('+fresh:7d'); }
  }

  // Hard filter for senior roles (word-boundary to avoid false positives)
  const hardFilters = ['senior', 'lead', 'staff', 'principal', 'manager'];
  const hardRegex = new RegExp(`\\b(${hardFilters.join('|')})\\b`, 'i');
  if (hardRegex.test(text)) {
    score -= 100;
    tier = 'C';
    hits.push('hard:senior');
  }

  return { score, tier, hits };
}

module.exports = { scoreJD };
