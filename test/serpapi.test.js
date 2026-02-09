const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePostedAt, pickDirectUrl } = require('../src/lib/sources/serpapi');

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

test('normalizePostedAt keeps ISO dates', () => {
  assert.equal(normalizePostedAt('2026-02-01'), '2026-02-01');
});

test('normalizePostedAt handles today/yesterday', () => {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  assert.equal(normalizePostedAt('today'), isoDate(today));
  assert.equal(normalizePostedAt('yesterday'), isoDate(yesterday));
});

test('normalizePostedAt handles relative days', () => {
  const today = new Date();
  const expected = isoDate(new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000));
  assert.equal(normalizePostedAt('3 days ago'), expected);
});

test('pickDirectUrl prefers non-google apply option link', () => {
  const job = {
    apply_options: [
      { title: 'Google', link: 'https://www.google.com/search?q=job' },
      { title: 'Company', link: 'https://jobs.example.com/role/123' },
    ],
  };
  assert.equal(pickDirectUrl(job), 'https://jobs.example.com/role/123');
});

test('pickDirectUrl decodes google redirect links when possible', () => {
  const encoded = encodeURIComponent('https://careers.example.com/jobs/789');
  const job = {
    related_links: [
      { title: 'Google Redirect', link: `https://www.google.com/url?q=${encoded}&sa=D` },
    ],
  };
  assert.equal(pickDirectUrl(job), 'https://careers.example.com/jobs/789');
});

test('pickDirectUrl returns null when only google links are available', () => {
  const job = {
    apply_options: [{ title: 'Google', link: 'https://www.google.com/search?q=test' }],
    related_links: [{ title: 'Google CA', link: 'https://www.google.ca/search?q=test2' }],
    share_link: 'https://www.google.com/jobs/results/abc',
  };
  assert.equal(pickDirectUrl(job), null);
});
