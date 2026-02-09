const test = require('node:test');
const assert = require('node:assert/strict');

const { pickDirectUrl } = require('../src/lib/sources/serpapi');

test('pickDirectUrl prefers non-google apply options', () => {
  const job = {
    apply_options: [
      { link: 'https://www.google.com/apply?id=123' },
      { link: 'https://company.com/jobs/1' },
    ],
    related_links: [{ link: 'https://google.com/search?q=job' }],
    share_link: 'https://google.com/share',
  };

  assert.equal(pickDirectUrl(job), 'https://company.com/jobs/1');
});

test('pickDirectUrl filters non-.com google domains', () => {
  const job = {
    apply_options: [
      { link: 'https://www.google.ca/apply?id=123' },
      { link: 'https://company.ca/jobs/1' },
    ],
  };

  assert.equal(pickDirectUrl(job), 'https://company.ca/jobs/1');
});

test('pickDirectUrl falls back to related_links when no apply option', () => {
  const job = {
    related_links: [{ link: 'https://company.com/careers/2' }],
  };

  assert.equal(pickDirectUrl(job), 'https://company.com/careers/2');
});
