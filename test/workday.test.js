const test = require('node:test');
const assert = require('node:assert/strict');

const { extractWorkdayConfig, normalizePostedAt } = require('../src/lib/sources/workday');

test('extractWorkdayConfig builds cxs API URL', () => {
  const cfg = extractWorkdayConfig('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite');
  assert.equal(cfg?.tenant, 'nvidia');
  assert.equal(cfg?.site, 'NVIDIAExternalCareerSite');
  assert.equal(cfg?.apiUrl, 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs');
});

test('normalizePostedAt supports relative strings', () => {
  assert.equal(normalizePostedAt('today').length, 10);
  assert.equal(normalizePostedAt('3 days ago').length, 10);
});

