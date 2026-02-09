const WORKFLOW_STATUSES = ['inbox', 'approved', 'skipped', 'applied'];

function isValidWorkflowStatus(value) {
  return WORKFLOW_STATUSES.includes(value);
}

module.exports = {
  WORKFLOW_STATUSES,
  isValidWorkflowStatus,
};
