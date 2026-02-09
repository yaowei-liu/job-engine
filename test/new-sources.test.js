const test = require('node:test');
const assert = require('node:assert/strict');

const { extractCompanyIdentifier } = require('../src/lib/sources/smartrecruiters');
const { extractAccount } = require('../src/lib/sources/workable');
const { extractCompany: extractRecruiteeCompany } = require('../src/lib/sources/recruitee');
const { extractCompany: extractBambooCompany } = require('../src/lib/sources/bamboohr');
const { extractCompany: extractJobviteCompany } = require('../src/lib/sources/jobvite');

test('extractCompanyIdentifier parses smartrecruiters targets', () => {
  assert.equal(extractCompanyIdentifier('stripe'), 'stripe');
  assert.equal(extractCompanyIdentifier('https://jobs.smartrecruiters.com/Stripe'), 'Stripe');
});

test('extractAccount parses workable targets', () => {
  assert.equal(extractAccount('notion'), 'notion');
  assert.equal(extractAccount('https://apply.workable.com/notion/'), 'notion');
});

test('extractCompany parses recruitee targets', () => {
  assert.equal(extractRecruiteeCompany('acme'), 'acme');
  assert.equal(extractRecruiteeCompany('https://acme.recruitee.com/'), 'acme');
});

test('extractCompany parses bamboohr targets', () => {
  assert.equal(extractBambooCompany('acme'), 'acme');
  assert.equal(extractBambooCompany('https://acme.bamboohr.com/careers'), 'acme');
});

test('extractCompany parses jobvite targets', () => {
  assert.equal(extractJobviteCompany('acme'), 'acme');
  assert.equal(extractJobviteCompany('https://jobs.jobvite.com/acme/jobs'), 'acme');
});

