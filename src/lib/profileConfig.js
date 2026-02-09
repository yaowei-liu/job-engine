const fs = require('fs');
const path = require('path');

const DEFAULT_PROFILE = {
  target_roles: ['software engineer', 'backend engineer', 'full stack engineer', 'new grad', 'entry level'],
  must_have_skills: [],
  nice_to_have_skills: [],
  location_preferences: ['toronto', 'ontario', 'canada', 'remote'],
  remote_policy: 'hybrid_or_remote',
  hard_exclusions: ['senior', 'staff', 'principal', 'manager', 'director'],
};

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
}

function loadProfileConfig() {
  const filePath = path.join(__dirname, '../../config/profile.json');
  if (!fs.existsSync(filePath)) return { ...DEFAULT_PROFILE };

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      target_roles: normalizeList(parsed.target_roles).length ? normalizeList(parsed.target_roles) : DEFAULT_PROFILE.target_roles,
      must_have_skills: normalizeList(parsed.must_have_skills),
      nice_to_have_skills: normalizeList(parsed.nice_to_have_skills),
      location_preferences: normalizeList(parsed.location_preferences).length
        ? normalizeList(parsed.location_preferences)
        : DEFAULT_PROFILE.location_preferences,
      remote_policy: String(parsed.remote_policy || DEFAULT_PROFILE.remote_policy).toLowerCase(),
      hard_exclusions: normalizeList(parsed.hard_exclusions).length
        ? normalizeList(parsed.hard_exclusions)
        : DEFAULT_PROFILE.hard_exclusions,
    };
  } catch (err) {
    console.warn('[Config] Failed to parse config/profile.json:', err.message);
    return { ...DEFAULT_PROFILE };
  }
}

module.exports = { loadProfileConfig, DEFAULT_PROFILE };
