const test = require('node:test');
const assert = require('node:assert/strict');

const { calculatePerRunLimit, calculateRemainingRunSlots } = require('../src/lib/serpapiBudget');

test('calculatePerRunLimit honors cap and reserve', () => {
  const perRun = calculatePerRunLimit({
    monthlyCap: 250,
    usedThisMonth: 50,
    reserve: 10,
    remainingRunSlots: 19,
  });
  assert.equal(perRun, 10);
});

test('calculatePerRunLimit returns 0 when exhausted', () => {
  const perRun = calculatePerRunLimit({
    monthlyCap: 250,
    usedThisMonth: 245,
    reserve: 10,
    remainingRunSlots: 2,
  });
  assert.equal(perRun, 0);
});

test('calculateRemainingRunSlots is at least one', () => {
  const now = new Date('2026-02-28T23:59:00.000Z');
  const slots = calculateRemainingRunSlots(now, 1440);
  assert.ok(slots >= 1);
});

