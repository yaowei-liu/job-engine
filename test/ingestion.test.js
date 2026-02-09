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
  assert.equal(fit.llmEligible, false);
  assert.equal(fit.llmAttempted, false);
  assert.equal(fit.llmSkippedReason, null);
});

test('evaluateJobFit marks llm as eligible and skipped when borderline with llm disabled', async () => {
  const fit = await evaluateJobFit({
    normalizedJob: {
      title: 'Software Engineer',
      location: 'Canada',
      jd_text: 'Software engineer role building APIs with Node and React',
    },
    profile: {
      target_roles: ['software engineer'],
      must_have_skills: [],
      nice_to_have_skills: ['react'],
      location_preferences: ['toronto', 'canada', 'remote'],
      hard_exclusions: ['senior', 'staff', 'principal'],
    },
    qualityOptions: {
      minInboxScore: 70,
      borderlineMin: 30,
      borderlineMax: 69,
      llm: { enabled: 'false' },
    },
  });

  assert.equal(fit.llmEligible, true);
  assert.equal(fit.llmAttempted, true);
  assert.equal(typeof fit.llmSkippedReason, 'string');
  assert.equal(fit.llmUsed, false);
});

test('evaluateJobFit batch mode without API key falls back without pending queue', async () => {
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalLLM = process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;

  try {
    const fit = await evaluateJobFit({
      normalizedJob: {
        title: 'Software Engineer',
        location: 'Canada',
        jd_text: 'Software engineer role building APIs with Node and React',
      },
      profile: {
        target_roles: ['software engineer'],
        must_have_skills: [],
        nice_to_have_skills: ['react'],
        location_preferences: ['toronto', 'canada', 'remote'],
        hard_exclusions: ['senior', 'staff', 'principal'],
      },
      qualityOptions: {
        minInboxScore: 70,
        borderlineMin: 30,
        borderlineMax: 69,
        llm: { enabled: 'true', mode: 'batch' },
      },
      runId: 1,
      jobId: 123,
    });

    assert.equal(fit.llmEligible, true);
    assert.equal(fit.llmAttempted, true);
    assert.equal(fit.llmQueued, false);
    assert.equal(typeof fit.llmSkippedReason, 'string');
  } finally {
    if (typeof originalOpenAI === 'string') process.env.OPENAI_API_KEY = originalOpenAI;
    else delete process.env.OPENAI_API_KEY;
    if (typeof originalLLM === 'string') process.env.LLM_API_KEY = originalLLM;
    else delete process.env.LLM_API_KEY;
  }
});
