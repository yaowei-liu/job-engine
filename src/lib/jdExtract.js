function extractYearsRequirement(text = '') {
  const lower = text.toLowerCase();
  const patterns = [
    /(\d+)\s*\+?\s*years?/,
    /(\d+)\s*-\s*(\d+)\s*years?/, 
    /(\d+)\s*to\s*(\d+)\s*years?/, 
  ];

  for (const p of patterns) {
    const m = lower.match(p);
    if (!m) continue;
    if (m[2]) return `${m[1]}-${m[2]} years`;
    return `${m[1]}+ years`;
  }

  return null;
}

module.exports = { extractYearsRequirement };
