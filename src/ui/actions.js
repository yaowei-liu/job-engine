export function createUndoController({ state, el, updateStatus, load, showError }) {
  function clearUndoTimers() {
    if (state.undoTimer) {
      clearTimeout(state.undoTimer);
      state.undoTimer = null;
    }
    if (state.undoCountdownTimer) {
      clearInterval(state.undoCountdownTimer);
      state.undoCountdownTimer = null;
    }
  }

  function hideUndoToast() {
    clearUndoTimers();
    el.undoToast.classList.remove('undo-toast-visible');
    state.pendingUndo = null;
  }

  function showUndoToast(payload) {
    clearUndoTimers();
    state.pendingUndo = payload;
    el.undoText.textContent = payload.message;
    let remaining = 8;
    el.undoCountdown.textContent = `Undo available for ${remaining}s`;
    el.undoToast.classList.add('undo-toast-visible');

    state.undoCountdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) return;
      el.undoCountdown.textContent = `Undo available for ${remaining}s`;
    }, 1000);

    state.undoTimer = setTimeout(() => {
      hideUndoToast();
    }, 8000);
  }

  async function undoLastAction() {
    if (!state.pendingUndo) return;
    const payload = state.pendingUndo;
    hideUndoToast();
    const ok = await updateStatus(payload.jobId, payload.previousStatus);
    if (!ok) {
      showError('Failed to undo the last action');
      return;
    }
    await load();
  }

  return {
    clearUndoTimers,
    hideUndoToast,
    showUndoToast,
    undoLastAction,
  };
}

export async function animateChoice({
  id,
  status,
  state,
  el,
  stageToStatus,
  updateStatus,
  renderList,
  showUndoToast,
  loadStageCounts,
  load,
}) {
  const card = el.list.querySelector(`.job-card[data-id="${id}"]`);
  const job = state.jobs.find((j) => j.id === Number(id));
  const prevStatus = job?.status || stageToStatus[state.stage] || 'inbox';
  const statusLabel = status === 'approved'
    ? 'approved'
    : status === 'skipped'
      ? 'archive'
      : status === 'applied'
        ? 'applied'
        : status;

  if (card) card.classList.add(`choice-${status}`);
  await new Promise((resolve) => setTimeout(resolve, 210));

  const ok = await updateStatus(id, status);
  if (!ok) {
    if (card) card.classList.remove(`choice-${status}`);
    return;
  }

  state.jobs = state.jobs.filter((current) => current.id !== Number(id));
  state.total = Math.max(0, state.total - 1);
  if (state.selectedIndex >= state.jobs.length) state.selectedIndex = Math.max(0, state.jobs.length - 1);
  renderList();

  if (prevStatus !== status) {
    showUndoToast({
      jobId: Number(id),
      previousStatus: prevStatus,
      newStatus: status,
      message: `${job?.company || 'Job'} moved to ${statusLabel}.`,
    });
  }

  el.stageSummary.classList.add('pulse-notice');
  setTimeout(() => el.stageSummary.classList.remove('pulse-notice'), 300);
  loadStageCounts();
  if (!state.jobs.length) load();
}
