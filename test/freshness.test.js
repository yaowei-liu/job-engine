const test = require('node:test');
const assert = require('node:assert/strict');

const { filterJobsByFreshness, isFreshWithinHours } = require('../src/lib/freshness');

test('isFreshWithinHours keeps day-level date within cutoff day', () => {
  const now = new Date('2026-02-09T20:00:00.000Z');
  assert.equal(isFreshWithinHours('2026-02-08', 24, now), true);
  assert.equal(isFreshWithinHours('2026-02-07', 24, now), false);
});

test('filterJobsByFreshness drops old and unknown by default', () => {
  const now = new Date('2026-02-09T20:00:00.000Z');
  const out = filterJobsByFreshness(
    [
      { title: 'A', post_date: '2026-02-09' },
      { title: 'B', post_date: '2026-02-01' },
      { title: 'C', post_date: null },
    ],
    { now, hours: 24 }
  );

  assert.equal(out.jobs.length, 1);
  assert.equal(out.stats.droppedOld, 1);
  assert.equal(out.stats.droppedUnknownDate, 1);
});

