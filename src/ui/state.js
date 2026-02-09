export const STAGE_TO_STATUS = {
  inbox: 'inbox',
  approved: 'approved',
  applied: 'applied',
  archive: 'skipped',
  filtered: 'filtered',
};

export const STAGE_COPY = {
  inbox: 'Viewing inbox: triage each item with approve or skip.',
  approved: 'Viewing approved: focus this list when you are ready to apply.',
  applied: 'Viewing applied: completed applications.',
  archive: 'Viewing archive: skipped jobs are stored here and shown less frequently.',
  filtered: 'Viewing filtered: rejected by quality gate or LLM. Use this for calibration.',
};

export function createState() {
  return {
    page: 1,
    pageSize: 20,
    jobs: [],
    total: 0,
    selectedIndex: 0,
    stage: 'inbox',
    stageCounts: {
      inbox: 0,
      approved: 0,
      applied: 0,
      archive: 0,
      filtered: 0,
    },
    pendingUndo: null,
    undoTimer: null,
    undoCountdownTimer: null,
    loadSeq: 0,
    countsSeq: 0,
  };
}
