function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function startOfMonthUTC(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfNextMonthUTC(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

function calculateRemainingRunSlots(now = new Date(), intervalMinutes = 1440) {
  const stepMs = Math.max(1, intervalMinutes) * 60 * 1000;
  const remainingMs = startOfNextMonthUTC(now).getTime() - now.getTime();
  return Math.max(1, Math.ceil(remainingMs / stepMs));
}

function calculatePerRunLimit({
  monthlyCap = 250,
  usedThisMonth = 0,
  reserve = 10,
  remainingRunSlots = 1,
}) {
  const capped = Math.max(0, monthlyCap);
  const used = Math.max(0, usedThisMonth);
  const holdback = Math.max(0, reserve);
  const runs = Math.max(1, remainingRunSlots);
  const available = Math.max(0, capped - used - holdback);
  return Math.floor(available / runs);
}

async function getUsageThisMonth(now = new Date()) {
  const { dbGet } = require('./db');
  const start = startOfMonthUTC(now).toISOString();
  const end = startOfNextMonthUTC(now).toISOString();
  const row = await dbGet(
    `SELECT COALESCE(SUM(queries_used), 0) AS used
     FROM serpapi_usage
     WHERE created_at >= ? AND created_at < ?`,
    [start, end]
  );
  return row?.used || 0;
}

async function recordUsage({ runId = null, queriesUsed = 0, notes = null } = {}) {
  const { dbRun } = require('./db');
  const used = Math.max(0, parseInt(String(queriesUsed), 10) || 0);
  if (!used) return;
  await dbRun(
    `INSERT INTO serpapi_usage (run_id, queries_used, notes)
     VALUES (?, ?, ?)`,
    [runId, used, notes]
  );
}

async function getSerpApiRunBudget(options = {}) {
  const now = options.now || new Date();
  const monthlyCap = parsePositiveInt(options.monthlyCap || process.env.SERPAPI_MONTHLY_QUERY_CAP, 250);
  const reserve = parsePositiveInt(options.reserve || process.env.SERPAPI_BUDGET_SAFETY_RESERVE, 10);
  const intervalMinutes = parsePositiveInt(options.intervalMinutes || process.env.SERPAPI_FETCH_INTERVAL_MIN, 1440);
  const usedThisMonth = await getUsageThisMonth(now);
  const remainingRunSlots = calculateRemainingRunSlots(now, intervalMinutes);
  const perRunLimit = calculatePerRunLimit({
    monthlyCap,
    usedThisMonth,
    reserve,
    remainingRunSlots,
  });

  return {
    monthlyCap,
    reserve,
    usedThisMonth,
    remainingRunSlots,
    perRunLimit,
    remainingBudget: Math.max(0, monthlyCap - usedThisMonth),
  };
}

module.exports = {
  calculatePerRunLimit,
  calculateRemainingRunSlots,
  getSerpApiRunBudget,
  recordUsage,
  startOfMonthUTC,
  startOfNextMonthUTC,
};
