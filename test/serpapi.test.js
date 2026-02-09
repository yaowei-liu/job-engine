const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePostedAt } = require('../src/lib/sources/serpapi');

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
