const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFingerprint, evaluateJobFit } = require('../src/lib/ingestion');

test('buildFingerprint prefers normalized URL host and path', () => {
  const fp = buildFingerprint({
    company: 'Acme',
    title: 'Software Engineer',
    url: 'https://www.example.com/jobs/123?utm_source=test',
  });

  assert.equal(fp.reason, 'url');
  assert.equal(fp.value, 'url:example.com/jobs/123');
});

test('buildFingerprint falls back to composite key when URL missing', () => {
  const fp = buildFingerprint({
    company: 'Acme',
    title: 'Software Engineer',
    location: 'Toronto',
    post_date: '2026-02-01',
  });

  assert.equal(fp.reason, 'company+title+location+post_date');
  assert.equal(fp.value, 'composite:acme|software engineer|toronto|2026-02-01');
});

test('evaluateJobFit returns filtered for hard exclusion without using llm', async () => {
  const fit = await evaluateJobFit({
    normalizedJob: {
      title: 'Senior Platform Engineer',
      location: 'Toronto, ON, Canada',
      jd_text: 'Senior platform engineering role with strong ownership expectations',
    },
    profile: {
      target_roles: ['software engineer', 'backend engineer'],
      must_have_skills: [],
      nice_to_have_skills: [],
      location_preferences: ['toronto', 'canada', 'remote'],
      hard_exclusions: ['senior', 'staff', 'principal'],
    },
    qualityOptions: {
      minInboxScore: 55,
      borderlineMin: 35,
      borderlineMax: 54,
      llm: { enabled: 'false' },
    },
  });

  assert.equal(fit.admittedToInbox, false);
  assert.equal(fit.qualityBucket, 'filtered');
  assert.equal(fit.fitLabel, 'low');
  assert.equal(fit.llmUsed, false);
});
