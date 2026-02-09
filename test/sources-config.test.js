const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getListSetting,
  getIntSetting,
  getBoolSetting,
  getStringSetting,
} = require('../src/lib/sourcesConfig');

test('getListSetting prefers env then config then fallback', () => {
  assert.deepEqual(getListSetting('a,b', ['x'], ['y']), ['a', 'b']);
  assert.deepEqual(getListSetting('', ['x', 'z'], ['y']), ['x', 'z']);
  assert.deepEqual(getListSetting('', [], ['y']), ['y']);
});

test('getIntSetting validates positive ints', () => {
  assert.equal(getIntSetting('5', 3, 1), 5);
  assert.equal(getIntSetting('', 3, 1), 3);
  assert.equal(getIntSetting('', 0, 1), 1);
});

test('bool and string setting helpers follow precedence', () => {
  assert.equal(getBoolSetting('true', false, false), true);
  assert.equal(getBoolSetting('', true, false), true);
  assert.equal(getStringSetting(' x ', 'y', 'z'), 'x');
  assert.equal(getStringSetting('', ' y ', 'z'), 'y');
});

