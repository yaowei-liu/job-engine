export function renderStageButtons({ state, el, stageCopy }) {
  for (const button of el.stageButtons) {
    const isActive = button.dataset.stage === state.stage;
    button.classList.toggle('stage-chip-active', isActive);
    button.classList.toggle('bg-white', !isActive);
  }
  el.stageSummary.textContent = stageCopy[state.stage];
  el.countInbox.textContent = state.stageCounts.inbox;
  el.countApproved.textContent = state.stageCounts.approved;
  el.countApplied.textContent = state.stageCounts.applied;
  el.countArchive.textContent = state.stageCounts.archive;
  el.countFiltered.textContent = state.stageCounts.filtered;
}

function parseHits(value) {
  try {
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

function parseReasonCodes(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseMissingSkills(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function actionsForStage(stage, jobId) {
  if (stage === 'inbox') {
    return `
      <button data-action="approved" data-id="${jobId}" class="px-3 py-1.5 rounded-md bg-teal-100 text-teal-800 text-sm font-medium">Approve</button>
      <button data-action="skipped" data-id="${jobId}" class="px-3 py-1.5 rounded-md bg-slate-100 text-slate-700 text-sm font-medium">Skip</button>
    `;
  }
  if (stage === 'approved') {
    return `
      <button data-action="applied" data-id="${jobId}" class="px-3 py-1.5 rounded-md bg-emerald-100 text-emerald-800 text-sm font-medium">Mark Applied</button>
      <button data-action="skipped" data-id="${jobId}" class="px-3 py-1.5 rounded-md bg-slate-100 text-slate-700 text-sm font-medium">Archive</button>
    `;
  }
  if (stage === 'archive') {
    return `
      <button data-action="approved" data-id="${jobId}" class="px-3 py-1.5 rounded-md bg-sky-100 text-sky-800 text-sm font-medium">Move to Approved</button>
    `;
  }
  if (stage === 'filtered') {
    return `
      <button data-action="inbox" data-id="${jobId}" class="px-3 py-1.5 rounded-md bg-amber-100 text-amber-800 text-sm font-medium">Move to Inbox</button>
    `;
  }
  return '';
}

export function renderList({ state, el }) {
  el.list.innerHTML = '';
  el.empty.classList.toggle('hidden', state.jobs.length > 0);

  const statusColor = {
    inbox: 'bg-amber-100 text-amber-700',
    approved: 'bg-sky-100 text-sky-700',
    applied: 'bg-emerald-100 text-emerald-700',
    skipped: 'bg-slate-100 text-slate-500',
    filtered: 'bg-rose-100 text-rose-700',
  };

  state.jobs.forEach((job, index) => {
    const card = document.createElement('article');
    card.className = `job-card bg-white rounded-xl p-4 shadow-sm ${index === state.selectedIndex ? 'job-selected' : ''}`;
    card.dataset.index = String(index);
    card.dataset.id = String(job.id);
    card.style.animationDelay = `${Math.min(index * 25, 180)}ms`;

    const hits = parseHits(job.hits);
    const reasonCodes = parseReasonCodes(job.fit_reason_codes);
    const missingSkills = parseMissingSkills(job.llm_missing_must_have);
    const actions = actionsForStage(state.stage, job.id);
    const fitBadge = (() => {
      if (job.fit_label === 'high') return 'bg-emerald-100 text-emerald-700';
      if (job.fit_label === 'medium') return 'bg-amber-100 text-amber-700';
      if (job.fit_label === 'low') return 'bg-rose-100 text-rose-700';
      return 'bg-slate-100 text-slate-600';
    })();

    card.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="font-semibold text-slate-800">${job.title}</h3>
          <p class="text-sm text-slate-600">${job.company}</p>
          <div class="mt-2 text-xs text-slate-500 flex flex-wrap gap-2">
            ${job.location ? `<span>${job.location}</span>` : ''}
            <span>Score: ${job.score}</span>
            <span>Tier: ${job.tier}</span>
            <span>Source: ${job.source || 'unknown'}</span>
            ${job.fit_label ? `<span class="px-2 py-0.5 rounded-full ${fitBadge}">Fit: ${job.fit_label} (${job.fit_score || 0})</span>` : ''}
            ${job.llm_review_state === 'pending' ? '<span class="px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">LLM pending</span>' : ''}
            ${job.llm_review_state === 'failed' ? '<span class="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">LLM failed</span>' : ''}
            ${job.years_req ? `<span>${job.years_req}</span>` : ''}
          </div>
          <div class="mt-1 text-xs text-slate-500 flex flex-wrap gap-2">
            <span>First seen: ${job.first_seen_at || '-'}</span>
            <span>Last seen: ${job.last_seen_at || '-'}</span>
            <span>Dedup: ${job.dedup_reason || '-'}</span>
          </div>
          ${(state.stage === 'filtered' || job.status === 'filtered') ? `
            <div class="mt-2 rounded-lg border border-rose-200 bg-rose-50/80 p-2">
              <p class="text-xs font-semibold text-rose-700">Why filtered</p>
              <p class="mt-1 text-xs text-rose-800">
                Source: ${job.fit_source || 'rules'} · Bucket: ${job.quality_bucket || 'filtered'} · Fit: ${job.fit_label || 'low'} (${job.fit_score || 0})
              </p>
              ${reasonCodes.length ? `<p class="mt-1 text-xs text-rose-800">Reasons: ${reasonCodes.slice(0, 6).join(' | ')}</p>` : '<p class="mt-1 text-xs text-rose-700">No reason codes recorded.</p>'}
              ${missingSkills.length ? `<p class="mt-1 text-xs text-rose-800">Missing must-have: ${missingSkills.slice(0, 6).join(', ')}</p>` : ''}
              ${job.llm_review_error ? `<p class="mt-1 text-xs text-rose-700">LLM note: ${job.llm_review_error}</p>` : ''}
            </div>
          ` : ''}
          ${hits.length ? `<p class="mt-1 text-xs text-slate-400">Hits: ${hits.join(' | ')}</p>` : ''}
          ${job.url
            ? `<a href="${job.url}" target="_blank" class="inline-block mt-2 text-sm text-sky-700 hover:text-sky-900">Open posting</a>`
            : (job.source === 'serpapi'
              ? '<span class="inline-block mt-2 text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800">Link unavailable</span>'
              : '')}
        </div>
        <div class="flex flex-col gap-2 shrink-0">
          <span class="px-2 py-0.5 rounded-full text-xs font-medium ${statusColor[job.status] || 'bg-slate-100 text-slate-700'}">${job.status || 'inbox'}</span>
          ${actions}
          <button data-action="provenance" data-id="${job.id}" class="px-3 py-1.5 rounded-md bg-indigo-100 text-indigo-800 text-sm">Provenance</button>
        </div>
      </div>
    `;

    el.list.appendChild(card);
  });

  const totalPages = Math.max(Math.ceil(state.total / state.pageSize), 1);
  el.pagination.textContent = `Page ${state.page} of ${totalPages}`;
  el.prevPage.disabled = state.page <= 1;
  el.nextPage.disabled = state.page >= totalPages;
  el.pageStats.textContent = `Page ${state.page}, size ${state.pageSize}`;
  el.stats.textContent = `${state.total} jobs in ${state.stage}`;
}

export function syncListAfterRemoval({ state, el, removedId }) {
  const removedCard = el.list.querySelector(`.job-card[data-id="${removedId}"]`);
  if (removedCard) removedCard.remove();

  const cards = Array.from(el.list.querySelectorAll('.job-card'));
  cards.forEach((card, index) => {
    card.dataset.index = String(index);
    card.classList.toggle('job-selected', index === state.selectedIndex);
  });

  el.empty.classList.toggle('hidden', state.jobs.length > 0);
  const totalPages = Math.max(Math.ceil(state.total / state.pageSize), 1);
  el.pagination.textContent = `Page ${state.page} of ${totalPages}`;
  el.prevPage.disabled = state.page <= 1;
  el.nextPage.disabled = state.page >= totalPages;
  el.pageStats.textContent = `Page ${state.page}, size ${state.pageSize}`;
  el.stats.textContent = `${state.total} jobs in ${state.stage}`;
}

export function renderRunSummary({ run, el }) {
  if (!run) return;
  el.runStatus.textContent = run.status;
  el.runStatus.className = `text-xs px-2 py-1 rounded-full ${run.status === 'success' ? 'bg-emerald-100 text-emerald-700' : run.status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`;
  const totals = run.summary?.totals || {};
  const quality = run.summary?.quality || {};
  const llm = run.summary?.llm || {};
  const resurfaced = totals.resurfaced || 0;
  const queuedText = llm.batchQueued ? `, batch queued ${llm.batchQueued}` : '';
  el.runSummary.textContent = `Run #${run.id} (${run.trigger}): fetched ${totals.fetched || 0}, inserted ${totals.inserted || 0}, deduped ${totals.deduped || 0}, resurfaced ${resurfaced}, failed ${totals.failed || 0}${queuedText}.`;
  const hard = quality.hardExclusionCount || 0;
  const loc = quality.locationMismatchCount || 0;
  const llmEligible = quality.borderlineSentToLlmCount || 0;
  if (el.runQualityHints) {
    el.runQualityHints.textContent = `Quality: hard exclusions ${hard}, location mismatches ${loc}, borderline sent to LLM ${llmEligible}.`;
  }
  el.runErrors.textContent = run.errorText || '';
  renderLlmProgress({
    progress: {
      status: run.status,
      llm: run.summary?.llm || { completed: run.summary?.quality?.llmUsed || 0 },
    },
    el,
  });
}

export function renderLlmProgress({ progress, el }) {
  const llm = progress?.llm || {};
  const eligible = Number(llm.eligible) || 0;
  const completed = Number(llm.completed) || 0;
  const skipped = Number(llm.skipped) || 0;
  const inFlight = Number(llm.inFlight) || 0;
  const resolved = completed + skipped;
  const percent = eligible > 0 ? Math.min(100, Math.round((resolved / eligible) * 100)) : 0;
  const status = progress?.status || 'idle';

  el.llmProgressMeta.textContent = `${percent}%`;
  el.llmProgressBar.style.width = `${percent}%`;

  if (status === 'running') {
    el.llmProgressDetail.textContent = `Completed ${completed}/${eligible} eligible, skipped ${skipped}, in-flight ${inFlight}.`;
    return;
  }
  if (!eligible && !completed && !skipped) {
    el.llmProgressDetail.textContent = 'No LLM-eligible jobs in this run.';
    return;
  }
  el.llmProgressDetail.textContent = `Run done: completed ${completed}/${eligible} eligible, skipped ${skipped}.`;
}
