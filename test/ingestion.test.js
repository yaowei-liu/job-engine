const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFingerprint } = require('../src/lib/ingestion');

test('buildFingerprint prefers normalized URL host and path', () => {
  const fp = buildFingerprint({
    company: 'Acme',
    title: 'Software Engineer',
    url: 'https://www.example.com/jobs/123?utm_source=test',
  });

  assert.equal(fp.reason, 'url');
  assert.equal(fp.value, 'url:example.com/jobs/123');
});

test('buildFingerprint falls back to composite key when URL missing', () => {
  const fp = buildFingerprint({
    company: 'Acme',
    title: 'Software Engineer',
    location: 'Toronto',
    post_date: '2026-02-01',
  });

  assert.equal(fp.reason, 'company+title+location+post_date');
  assert.equal(fp.value, 'composite:acme|software engineer|toronto|2026-02-01');
});
