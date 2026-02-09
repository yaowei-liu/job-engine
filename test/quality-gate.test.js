const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateDeterministicFit } = require('../src/lib/qualityGate');

const profile = {
  target_roles: ['software engineer', 'backend engineer', 'new grad'],
  must_have_skills: ['node', 'sql'],
  nice_to_have_skills: ['react'],
  location_preferences: ['toronto', 'canada', 'remote'],
  hard_exclusions: ['senior', 'staff', 'principal', 'manager'],
};

test('deterministic gate filters obvious senior roles', () => {
  const out = evaluateDeterministicFit(
    {
      title: 'Senior Software Engineer',
      location: 'Toronto, ON, Canada',
      jd_text: 'We need a senior engineer with 8+ years experience',
    },
    profile
  );

  assert.equal(out.admittedToInbox, false);
  assert.equal(out.qualityBucket, 'filtered');
  assert.equal(out.fitLabel, 'low');
});

test('deterministic gate admits strong entry-level matches', () => {
  const out = evaluateDeterministicFit(
    {
      title: 'Backend Software Engineer, New Grad',
      location: 'Toronto, ON, Canada',
      jd_text: 'Looking for new grad backend engineer with node and sql skills',
    },
    profile
  );

  assert.equal(out.admittedToInbox, true);
  assert.equal(out.fitLabel, 'high');
});

test('deterministic gate marks borderline for optional llm review', () => {
  const out = evaluateDeterministicFit(
    {
      title: 'Software Engineer',
      location: 'Canada',
      jd_text: 'Software engineer role working on Node APIs with collaborative product teams',
    },
    profile,
    { minInboxScore: 70, borderlineMin: 30, borderlineMax: 69 }
  );

  assert.equal(out.qualityBucket, 'borderline');
  assert.equal(out.needsLLM, true);
});

test('deterministic gate does not hard-penalize missing must-have skills', () => {
  const out = evaluateDeterministicFit(
    {
      title: 'Software Engineer',
      location: 'Toronto, ON, Canada',
      jd_text: 'Software engineer role building APIs and internal tools',
    },
    profile,
    { minInboxScore: 70, borderlineMin: 20, borderlineMax: 69 }
  );

  assert.equal(out.qualityBucket, 'borderline');
  assert.equal(out.needsLLM, true);
  assert.equal(out.reasonCodes.includes('must_skill:none'), true);
});

test('deterministic gate hard-filters experience variants for 8+ years keyword', () => {
  const profileWithYears = {
    ...profile,
    hard_exclusions: [...profile.hard_exclusions, '8+ years'],
  };
  const out = evaluateDeterministicFit(
    {
      title: 'Software Engineer',
      location: 'Toronto, ON, Canada',
      jd_text: 'Candidates need at least 9 years of experience building distributed systems',
    },
    profileWithYears
  );

  assert.equal(out.qualityBucket, 'filtered');
  assert.equal(out.reasonCodes.includes('hard_exclusion:8+ years'), true);
});
