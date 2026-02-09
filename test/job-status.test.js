const test = require('node:test');
const assert = require('node:assert/strict');

const { WORKFLOW_STATUSES, isValidWorkflowStatus } = require('../src/lib/jobStatus');

test('workflow statuses include inbox for undo and review flow', () => {
  assert.deepEqual(WORKFLOW_STATUSES, ['inbox', 'approved', 'skipped', 'applied']);
});

test('isValidWorkflowStatus accepts known statuses and rejects invalid values', () => {
  assert.equal(isValidWorkflowStatus('inbox'), true);
  assert.equal(isValidWorkflowStatus('approved'), true);
  assert.equal(isValidWorkflowStatus('skipped'), true);
  assert.equal(isValidWorkflowStatus('applied'), true);
  assert.equal(isValidWorkflowStatus('draft'), false);
  assert.equal(isValidWorkflowStatus(undefined), false);
});

