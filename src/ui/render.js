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
}

function parseHits(value) {
  try {
    return value ? JSON.parse(value) : [];
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
  };

  state.jobs.forEach((job, index) => {
    const card = document.createElement('article');
    card.className = `job-card bg-white rounded-xl p-4 shadow-sm ${index === state.selectedIndex ? 'job-selected' : ''}`;
    card.dataset.index = String(index);
    card.dataset.id = String(job.id);
    card.style.animationDelay = `${Math.min(index * 25, 180)}ms`;

    const hits = parseHits(job.hits);
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
            ${job.years_req ? `<span>${job.years_req}</span>` : ''}
          </div>
          <div class="mt-1 text-xs text-slate-500 flex flex-wrap gap-2">
            <span>First seen: ${job.first_seen_at || '-'}</span>
            <span>Last seen: ${job.last_seen_at || '-'}</span>
            <span>Dedup: ${job.dedup_reason || '-'}</span>
          </div>
          ${hits.length ? `<p class="mt-1 text-xs text-slate-400">Hits: ${hits.join(' | ')}</p>` : ''}
          ${job.url ? `<a href="${job.url}" target="_blank" class="inline-block mt-2 text-sm text-sky-700 hover:text-sky-900">Open posting</a>` : ''}
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
  el.runSummary.textContent = `Run #${run.id} (${run.trigger}): fetched ${totals.fetched || 0}, inserted ${totals.inserted || 0}, deduped ${totals.deduped || 0}, failed ${totals.failed || 0}.`;
  el.runErrors.textContent = run.errorText || '';
}
