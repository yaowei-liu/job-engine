import {
  fetchJobs,
  fetchLatestRun,
  fetchProvenance,
  fetchStageCount,
  triggerIngestionRun,
  updateJobStatus,
} from './api.js';
import { createState, STAGE_COPY, STAGE_TO_STATUS } from './state.js';
import {
  renderList,
  renderRunSummary,
  renderStageButtons,
  syncListAfterRemoval,
} from './render.js';
import { animateChoice, createUndoController } from './actions.js';

const state = createState();

const el = {
  list: document.getElementById('list'),
  tier: document.getElementById('tier'),
  source: document.getElementById('source'),
  sort: document.getElementById('sort'),
  bigtech: document.getElementById('bigtech'),
  hasErrors: document.getElementById('hasErrors'),
  seenWithinDays: document.getElementById('seenWithinDays'),
  q: document.getElementById('q'),
  minScore: document.getElementById('minScore'),
  stats: document.getElementById('stats'),
  pageStats: document.getElementById('page-stats'),
  stageSummary: document.getElementById('stage-summary'),
  errorBanner: document.getElementById('error-banner'),
  loading: document.getElementById('loading'),
  empty: document.getElementById('empty'),
  pagination: document.getElementById('pagination'),
  prevPage: document.getElementById('prev-page'),
  nextPage: document.getElementById('next-page'),
  runStatus: document.getElementById('run-status'),
  runSummary: document.getElementById('run-summary'),
  runErrors: document.getElementById('run-errors'),
  provenance: document.getElementById('provenance'),
  provenanceContent: document.getElementById('provenance-content'),
  stageButtons: Array.from(document.querySelectorAll('.stage-btn')),
  countInbox: document.getElementById('count-inbox'),
  countApproved: document.getElementById('count-approved'),
  countApplied: document.getElementById('count-applied'),
  countArchive: document.getElementById('count-archive'),
  undoToast: document.getElementById('undo-toast'),
  undoText: document.getElementById('undo-text'),
  undoCountdown: document.getElementById('undo-countdown'),
  undoBtn: document.getElementById('undo-btn'),
  refresh: document.getElementById('refresh'),
  runScan: document.getElementById('run-scan'),
  closeProvenance: document.getElementById('close-provenance'),
};

function showError(message) {
  el.errorBanner.textContent = message;
  el.errorBanner.classList.remove('hidden');
}

function clearError() {
  el.errorBanner.classList.add('hidden');
  el.errorBanner.textContent = '';
}

function applyQueryStateToUrl() {
  const params = new URLSearchParams();
  params.set('stage', state.stage);
  if (el.tier.value) params.set('tier', el.tier.value);
  if (el.source.value) params.set('source', el.source.value);
  if (el.sort.value) params.set('sort', el.sort.value);
  if (el.q.value) params.set('q', el.q.value);
  if (el.minScore.value) params.set('minScore', el.minScore.value);
  if (el.seenWithinDays.value) params.set('seenWithinDays', el.seenWithinDays.value);
  if (el.bigtech.checked) params.set('bigtech', 'true');
  if (el.hasErrors.checked) params.set('hasErrors', 'true');
  params.set('page', String(state.page));
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

function restoreQueryStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const stageParam = params.get('stage');
  const legacyStatus = params.get('status');
  if (stageParam && STAGE_TO_STATUS[stageParam]) {
    state.stage = stageParam;
  } else if (legacyStatus === 'skipped') {
    state.stage = 'archive';
  } else if (legacyStatus && STAGE_TO_STATUS[legacyStatus]) {
    state.stage = legacyStatus;
  } else {
    state.stage = 'inbox';
  }
  el.tier.value = params.get('tier') || '';
  el.source.value = params.get('source') || '';
  el.sort.value = params.get('sort') || 'newest';
  el.q.value = params.get('q') || '';
  el.minScore.value = params.get('minScore') || '';
  el.seenWithinDays.value = params.get('seenWithinDays') || '';
  el.bigtech.checked = params.get('bigtech') === 'true';
  el.hasErrors.checked = params.get('hasErrors') === 'true';
  state.page = Math.max(parseInt(params.get('page') || '1', 10), 1);
  renderStageButtons({ state, el, stageCopy: STAGE_COPY });
}

function buildFilterParams(stage = state.stage) {
  const params = new URLSearchParams();
  const status = STAGE_TO_STATUS[stage];
  if (status) params.set('status', status);
  if (el.tier.value) params.set('tier', el.tier.value);
  if (el.source.value) params.set('source', el.source.value);
  if (el.sort.value) params.set('sort', el.sort.value);
  if (el.q.value) params.set('q', el.q.value);
  if (el.minScore.value) params.set('minScore', el.minScore.value);
  if (el.seenWithinDays.value) params.set('seenWithinDays', el.seenWithinDays.value);
  if (el.bigtech.checked) params.set('bigtech', 'true');
  if (el.hasErrors.checked) params.set('hasErrors', 'true');
  return params;
}

async function loadRuns() {
  try {
    const run = await fetchLatestRun();
    renderRunSummary({ run, el });
  } catch {
    // keep silent, job list still usable
  }
}

async function loadStageCounts() {
  const countsId = ++state.countsSeq;
  try {
    const stages = ['inbox', 'approved', 'applied', 'archive'];
    const pairs = await Promise.all(
      stages.map(async (stage) => [stage, await fetchStageCount(buildFilterParams(stage))])
    );
    if (countsId !== state.countsSeq) return;
    for (const [stage, total] of pairs) state.stageCounts[stage] = total;
    renderStageButtons({ state, el, stageCopy: STAGE_COPY });
  } catch {
    // keep quiet, counts are a convenience
  }
}

async function load() {
  const loadId = ++state.loadSeq;
  clearError();
  el.loading.classList.remove('hidden');
  applyQueryStateToUrl();

  const params = buildFilterParams(state.stage);
  params.set('page', String(state.page));
  params.set('pageSize', String(state.pageSize));

  try {
    const data = await fetchJobs(params);
    if (loadId !== state.loadSeq) return;
    state.jobs = data.items || [];
    state.total = data.meta?.total || 0;
    if (state.selectedIndex >= state.jobs.length) state.selectedIndex = Math.max(0, state.jobs.length - 1);
    renderList({ state, el });
  } catch (err) {
    if (loadId !== state.loadSeq) return;
    showError(err.message || 'Failed to load jobs');
  } finally {
    if (loadId !== state.loadSeq) return;
    el.loading.classList.add('hidden');
    loadRuns();
    loadStageCounts();
  }
}

async function doUpdateStatus(id, status) {
  clearError();
  try {
    const payload = await updateJobStatus(id, status);
    if (payload.syncWarning) {
      showError(`Status updated, but sync warning: ${payload.syncWarning}`);
    }
    return true;
  } catch (err) {
    showError(err.message || 'Failed to update status');
    return false;
  }
}

async function loadProvenance(id) {
  clearError();
  try {
    const data = await fetchProvenance(id);
    el.provenance.classList.remove('hidden');
    el.provenanceContent.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    showError(err.message || 'Failed to load provenance');
  }
}

function selectRelative(offset) {
  if (!state.jobs.length) return;
  state.selectedIndex = Math.min(Math.max(state.selectedIndex + offset, 0), state.jobs.length - 1);
  renderList({ state, el });
  const selected = document.querySelector(`.job-card[data-index="${state.selectedIndex}"]`);
  if (selected) selected.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectedJob() {
  return state.jobs[state.selectedIndex];
}

const undo = createUndoController({
  state,
  el,
  updateStatus: doUpdateStatus,
  load,
  showError,
});

const triggerReload = () => {
  state.page = 1;
  load();
};

function runChoice(id, status) {
  return animateChoice({
    id,
    status,
    state,
    el,
    stageToStatus: STAGE_TO_STATUS,
    updateStatus: doUpdateStatus,
    renderList: () => renderList({ state, el }),
    syncListAfterRemoval: (removedId) => syncListAfterRemoval({ state, el, removedId }),
    showUndoToast: undo.showUndoToast,
    loadStageCounts,
    load,
  });
}

function setStage(stage) {
  if (!STAGE_TO_STATUS[stage]) return;
  if (state.stage === stage) return;
  state.stage = stage;
  state.page = 1;
  state.selectedIndex = 0;
  renderStageButtons({ state, el, stageCopy: STAGE_COPY });
  load();
}

el.stageButtons.forEach((button) => {
  button.addEventListener('click', () => setStage(button.dataset.stage));
});

el.list.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  const card = event.target.closest('.job-card');
  if (card && !button) {
    state.selectedIndex = Number(card.dataset.index || '0');
    renderList({ state, el });
  }
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === 'provenance') return loadProvenance(id);
  if (action === 'approved' || action === 'applied' || action === 'skipped') {
    return runChoice(id, action);
  }
});

el.prevPage.addEventListener('click', () => {
  if (state.page <= 1) return;
  state.page -= 1;
  load();
});

el.nextPage.addEventListener('click', () => {
  const totalPages = Math.max(Math.ceil(state.total / state.pageSize), 1);
  if (state.page >= totalPages) return;
  state.page += 1;
  load();
});

el.closeProvenance.addEventListener('click', () => {
  el.provenance.classList.add('hidden');
});

el.refresh.addEventListener('click', () => load());

el.runScan.addEventListener('click', async () => {
  const prevText = el.runScan.textContent;
  el.runScan.disabled = true;
  el.runScan.textContent = 'Running...';
  clearError();
  try {
    const data = await triggerIngestionRun();
    if (!data.accepted) {
      showError(data.message || 'Run already active');
    }
    await load();
  } catch (err) {
    showError(err.message || 'Failed to run ingestion');
  } finally {
    el.runScan.disabled = false;
    el.runScan.textContent = prevText;
  }
});

el.undoBtn.addEventListener('click', () => {
  undo.undoLastAction();
});

[el.tier, el.source, el.sort, el.minScore, el.seenWithinDays, el.bigtech, el.hasErrors].forEach((node) => {
  node.addEventListener('change', triggerReload);
});

el.q.addEventListener('input', () => {
  clearTimeout(window.__qTimer);
  window.__qTimer = setTimeout(triggerReload, 250);
});

document.addEventListener('keydown', (event) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  const key = event.key.toLowerCase();
  if (key === 'j') selectRelative(1);
  if (key === 'k') selectRelative(-1);
  if (key === 'a' && selectedJob()) runChoice(selectedJob().id, 'approved');
  if (key === 's' && selectedJob()) runChoice(selectedJob().id, 'skipped');
  if (key === 'l' && selectedJob()) runChoice(selectedJob().id, 'applied');
  if (key === 'z' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    undo.undoLastAction();
  }
});

restoreQueryStateFromUrl();
load();
