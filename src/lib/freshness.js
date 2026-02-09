function parsePostedAt(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { date: value, granularity: 'exact' };
  }

  const str = String(value).trim();
  if (!str) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(`${str}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) return { date: d, granularity: 'day' };
  }

  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) return { date: d, granularity: 'exact' };

  return null;
}

function isFreshWithinHours(value, hours = 24, now = new Date()) {
  const parsed = parsePostedAt(value);
  if (!parsed) return false;

  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
  if (parsed.granularity === 'day') {
    const dayKey = parsed.date.toISOString().slice(0, 10);
    const cutoffDayKey = cutoff.toISOString().slice(0, 10);
    return dayKey >= cutoffDayKey;
  }

  return parsed.date.getTime() >= cutoff.getTime();
}

function filterJobsByFreshness(jobs = [], options = {}) {
  const {
    hours = 24,
    allowUnknownDate = false,
    now = new Date(),
  } = options;

  const kept = [];
  let droppedOld = 0;
  let droppedUnknownDate = 0;

  for (const job of jobs) {
    if (!job?.post_date) {
      if (allowUnknownDate) {
        kept.push(job);
      } else {
        droppedUnknownDate += 1;
      }
      continue;
    }

    if (isFreshWithinHours(job.post_date, hours, now)) {
      kept.push(job);
    } else {
      droppedOld += 1;
    }
  }

  return {
    jobs: kept,
    stats: {
      rawFetched: jobs.length,
      keptFresh: kept.length,
      droppedOld,
      droppedUnknownDate,
      freshnessHours: hours,
      allowUnknownDate,
    },
  };
}

module.exports = {
  parsePostedAt,
  isFreshWithinHours,
  filterJobsByFreshness,
};
