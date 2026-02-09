const test = require('node:test');
const assert = require('node:assert/strict');

const { loadProfileConfig } = require('../src/lib/profileConfig');

test('loadProfileConfig returns normalized profile fields', () => {
  const profile = loadProfileConfig();
  assert.ok(Array.isArray(profile.target_roles));
  assert.ok(Array.isArray(profile.must_have_skills));
  assert.ok(Array.isArray(profile.hard_exclusions));
  assert.equal(typeof profile.remote_policy, 'string');
  if (profile.target_roles.length) {
    assert.equal(profile.target_roles[0], profile.target_roles[0].toLowerCase());
  }
});

