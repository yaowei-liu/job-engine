const test = require('node:test');
const assert = require('node:assert/strict');

const { extractCompanySlug } = require('../src/lib/sources/lever');

test('extractCompanySlug parses lever board urls', () => {
  assert.equal(extractCompanySlug('https://jobs.lever.co/acme'), 'acme');
  assert.equal(extractCompanySlug('https://jobs.lever.co/Acme-Robotics'), 'Acme-Robotics');
});
