const test = require('node:test');
const assert = require('node:assert/strict');

const { extractBoardToken } = require('../src/lib/sources/greenhouse');

test('extractBoardToken accepts hyphens and uppercase', () => {
  assert.equal(extractBoardToken('https://boards.greenhouse.io/Acme-Robotics'), 'Acme-Robotics');
});
