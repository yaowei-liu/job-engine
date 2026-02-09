function countIncludes(text, keyword) {
  if (!text || !keyword) return 0;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
  return (text.match(regex) || []).length;
}

function parseMinYearsKeyword(keyword) {
  const m = String(keyword || '').toLowerCase().trim().match(/^(\d+)\s*\+\s*(?:years?|yrs?)$/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function hasMinYearsRequirement(text, minYears) {
  if (!text || !Number.isFinite(minYears)) return false;
  const regex = /\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b(?:\s+of\s+experience)?/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = parseInt(match[1], 10);
    if (Number.isFinite(value) && value >= minYears) return true;
  }
  return false;
}

function hasHardExclusion(text, keyword) {
  const minYears = parseMinYearsKeyword(keyword);
  if (Number.isFinite(minYears)) {
    return hasMinYearsRequirement(text, minYears);
  }
  return countIncludes(text, keyword) > 0;
}

function evaluateDeterministicFit(job = {}, profile = {}, options = {}) {
  const text = `${job.title || ''}\n${job.jd_text || ''}`.toLowerCase();
  const location = String(job.location || '').toLowerCase();
  const reasonCodes = [];
  let score = 0;
  let hardRejected = false;

  for (const kw of profile.hard_exclusions || []) {
    if (hasHardExclusion(text, kw)) {
      reasonCodes.push(`hard_exclusion:${kw}`);
      hardRejected = true;
    }
  }

  let roleHits = 0;
  for (const role of profile.target_roles || []) {
    const count = countIncludes(text, role);
    if (count > 0) {
      roleHits += count;
      score += 18;
      reasonCodes.push(`role_match:${role}`);
    }
  }

  let mustHits = 0;
  for (const skill of profile.must_have_skills || []) {
    const count = countIncludes(text, skill);
    if (count > 0) {
      mustHits += 1;
      score += 12;
      reasonCodes.push(`must_skill:${skill}`);
    }
  }

  for (const skill of profile.nice_to_have_skills || []) {
    const count = countIncludes(text, skill);
    if (count > 0) {
      score += 5;
      reasonCodes.push(`nice_skill:${skill}`);
    }
  }

  const prefers = profile.location_preferences || [];
  if (!location && options.allowUnknownLocation) {
    score += 4;
    reasonCodes.push('location:unknown_allowed');
  } else if (prefers.some((kw) => location.includes(kw))) {
    score += 10;
    reasonCodes.push('location:preferred');
  } else if (location) {
    score -= 10;
    reasonCodes.push('location:mismatch');
  }

  if (roleHits === 0) {
    score -= 15;
    reasonCodes.push('role:no_match');
  }

  if ((profile.must_have_skills || []).length && mustHits === 0) {
    reasonCodes.push('must_skill:none');
  }

  if (hardRejected) {
    return {
      fitScore: Math.max(0, score - 80),
      fitLabel: 'low',
      fitSource: 'rules',
      qualityBucket: 'filtered',
      admittedToInbox: false,
      needsLLM: false,
      reasonCodes,
    };
  }

  const minInboxScore = Math.max(1, parseInt(options.minInboxScore || '55', 10));
  const borderlineMin = Math.max(1, parseInt(options.borderlineMin || '35', 10));
  const borderlineMax = Math.max(borderlineMin, parseInt(options.borderlineMax || '54', 10));

  if (score >= minInboxScore) {
    return {
      fitScore: score,
      fitLabel: 'high',
      fitSource: 'rules',
      qualityBucket: 'high',
      admittedToInbox: true,
      needsLLM: false,
      reasonCodes,
    };
  }

  if (score >= borderlineMin && score <= borderlineMax) {
    return {
      fitScore: score,
      fitLabel: 'medium',
      fitSource: 'rules',
      qualityBucket: 'borderline',
      admittedToInbox: false,
      needsLLM: true,
      reasonCodes,
    };
  }

  return {
    fitScore: Math.max(0, score),
    fitLabel: 'low',
    fitSource: 'rules',
    qualityBucket: 'filtered',
    admittedToInbox: false,
    needsLLM: false,
    reasonCodes,
  };
}

module.exports = { evaluateDeterministicFit };
