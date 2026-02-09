const test = require('node:test');
const assert = require('node:assert/strict');

const { extractOrgSlug, flattenJobs } = require('../src/lib/sources/ashby');

test('extractOrgSlug supports slug and URL', () => {
  assert.equal(extractOrgSlug('notion'), 'notion');
  assert.equal(extractOrgSlug('https://jobs.ashbyhq.com/notion'), 'notion');
});

test('flattenJobs reads team jobs payload', () => {
  const payload = {
    data: {
      jobBoardWithTeams: {
        teams: [
          { jobs: [{ id: '1', title: 'Software Engineer' }] },
          { jobs: [{ id: '2', title: 'Backend Engineer' }] },
        ],
      },
    },
  };
  const jobs = flattenJobs(payload);
  assert.equal(jobs.length, 2);
});

