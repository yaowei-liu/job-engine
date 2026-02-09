const fs = require('fs');
const path = require('path');

function loadSearchConfig() {
  const p = path.join(__dirname, '../../config/search.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[Config] Failed to parse config/search.json:', e.message);
    return null;
  }
}

function buildQueriesFromConfig(cfg) {
  if (!cfg) return [];

  const base = cfg.queries || [];
  const levels = cfg.levels || [];
  const locations = cfg.locations || [];
  const negative = cfg.negative || [];
  const remote = cfg.remote ? 'remote' : '';
  const fullTime = cfg.full_time ? 'full time' : '';

  const negStr = negative.length ? negative.map((n) => `-${n}`).join(' ') : '';
  const levelStr = levels.join(' ');
  const flags = [remote, fullTime].filter(Boolean).join(' ');

  const queries = [];
  for (const q of base) {
    if (!locations.length) {
      queries.push([q, levelStr, flags, negStr].filter(Boolean).join(' ').trim());
      continue;
    }
    for (const loc of locations) {
      queries.push([q, levelStr, loc, flags, negStr].filter(Boolean).join(' ').trim());
    }
  }

  return queries;
}

module.exports = { loadSearchConfig, buildQueriesFromConfig };
