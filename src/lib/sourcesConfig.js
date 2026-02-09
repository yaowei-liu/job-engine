const fs = require('fs');
const path = require('path');

function loadSourcesConfig() {
  const p = path.join(__dirname, '../../config/sources.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[Config] Failed to parse config/sources.json:', e.message);
    return {};
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

function getListSetting(envValue, configValue, fallback = []) {
  if (typeof envValue === 'string' && envValue.trim()) return normalizeList(envValue);
  const fromConfig = normalizeList(configValue);
  if (fromConfig.length) return fromConfig;
  return normalizeList(fallback);
}

function getIntSetting(envValue, configValue, fallback) {
  if (typeof envValue === 'string' && envValue.trim()) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (Number.isFinite(configValue) && configValue > 0) return configValue;
  return fallback;
}

function getBoolSetting(envValue, configValue, fallback) {
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.toLowerCase() === 'true';
  }
  if (typeof configValue === 'boolean') return configValue;
  return fallback;
}

function getStringSetting(envValue, configValue, fallback = '') {
  if (typeof envValue === 'string' && envValue.trim()) return envValue.trim();
  if (typeof configValue === 'string' && configValue.trim()) return configValue.trim();
  return fallback;
}

module.exports = {
  getBoolSetting,
  getIntSetting,
  getListSetting,
  getStringSetting,
  loadSourcesConfig,
  normalizeList,
};
