/**
 * Turns measurements into recommendations. The rule of thumb throughout: a
 * number of runners is only justified by observed saturation, never guessed.
 */

/**
 * How much capacity to add. Uses the sampled run durations to estimate demand
 * (concurrency-hours needed per day) and compares it against what the current
 * fleet can supply in a day, then reports the gap.
 */
export function recommendFleet({ history, capacity, fleet = {} }) {
  const idleCeiling = fleet.idleCeiling ?? 0.15;
  const target = fleet.targetUtilisation ?? 0.8;

  if (!history?.daily?.length) {
    return { ok: false, reason: "not_enough_history", add: 0 };
  }
  if (!capacity?.total) {
    return { ok: false, reason: "no_runner_state", add: 0 };
  }

  // Mean run duration per job, then jobs per day observed.
  const meanJobS = history.overall.mean || 0;
  const jobsPerDay = history.overall.n / Math.max(1, history.daily.length);
  if (!meanJobS) {
    return { ok: false, reason: "not_enough_history", add: 0 };
  }

  const demandHoursPerDay = (meanJobS * jobsPerDay) / 3600;
  const supplyHoursPerDay = capacity.total * 24 * target;
  const utilisation = supplyHoursPerDay
    ? demandHoursPerDay / supplyHoursPerDay
    : Infinity;

  const blockedPerDay =
    (history.blockedHours?.totalHours ?? 0) /
    Math.max(1, history.blockedHours?.days ?? 1);

  let add = 0;
  let verdict;
  if (utilisation > target) {
    add = Math.max(1, Math.ceil(demandHoursPerDay / (24 * target) - capacity.total));
    verdict = "saturated";
  } else if (utilisation > target * 0.85) {
    verdict = "tight";
  } else {
    verdict = "healthy";
  }

  // Runners that are online but idle most of the time are not the constraint,
  // so growing the fleet would waste money.
  const idleShare = capacity.total ? capacity.idle / capacity.total : 1;

  return {
    ok: true,
    verdict,
    add,
    utilisation,
    idleShare,
    demandHoursPerDay,
    supplyHoursPerDay: capacity.total * 24,
    blockedHoursPerDay: blockedPerDay,
    ceilingBreached: idleShare > idleCeiling,
    reason:
      verdict === "saturated" && idleShare > idleCeiling
        ? "Jobs are queueing but runners are idle, so the bottleneck is labels, concurrency or runner health rather than a shortage of machines."
        : null,
  };
}

/**
 * Finds queued runs that newer runs have made pointless.
 *
 * A newer push to a branch supersedes the run it replaced -- that is the
 * common case, and safe to act on.
 *
 * It is NOT safe to generalise to every run on the same branch. Dependabot
 * `dynamic` runs all report the base branch as their head, so two unrelated
 * dependency bumps look identical here; cancelling the older one would throw
 * away work that is still wanted. Those are therefore never treated as
 * superseded, and neither is a manual dispatch.
 */
export function findSuperseded(jobs) {
  const supersedable = jobs.filter((r) =>
    SUPERSEDABLE_EVENTS.has(r.event),
  );

  // Newest run per (repo, branch, commit).
  const latest = new Map();
  for (const job of supersedable) {
    const key = `${job.repo}|${job.branch}|${job.headSha ?? ""}`;
    const current = latest.get(key);
    if (!current || job.createdAt > current.createdAt) {
      latest.set(key, job);
    }
  }

  const superseded = [];
  const seenRun = new Set();
  for (const job of supersedable) {
    const key = `${job.repo}|${job.branch}|${job.headSha ?? ""}`;
    const newest = latest.get(key);
    if (newest && newest.runId !== job.runId && !seenRun.has(job.runId)) {
      seenRun.add(job.runId);
      superseded.push({
        ...job,
        supersededBy: {
          runId: newest.runId,
          runNumber: newest.runNumber,
          createdAt: newest.createdAt,
          url: newest.url,
        },
      });
    }
  }
  return superseded.sort((a, b) => b.waitS - a.waitS);
}

// A run is only superseded by a newer commit of the same branch.
const SUPERSEDABLE_EVENTS = new Set(["push", "pull_request"]);

/**
 * Decides whether to fire an alert. Requires the problem to have persisted,
 * and rate-limits itself so one long incident does not page repeatedly.
 */
export function shouldAlert({ jobs, thresholdS, sustainedMinutes, state, now = Date.now() }) {
  if (!jobs.length) return { fire: false, reason: "queue_empty" };

  const worst = jobs[0].waitS;
  if (worst < thresholdS) return { fire: false, reason: "under_threshold" };

  const sustainedS = (sustainedMinutes ?? 15) * 60;
  if (worst < sustainedS) {
    return {
      fire: false,
      reason: "not_sustained",
      worstWaitS: worst,
    };
  }

  if (state?.lastFiredAt && now - state.lastFiredAt < (state.cooldownMinutes ?? 60) * 60_000) {
    return { fire: false, reason: "cooldown", lastFiredAt: state.lastFiredAt };
  }

  return {
    fire: true,
    worstWaitS: worst,
    stuckJobs: jobs.filter((j) => j.waitS >= thresholdS).length,
    causes: summariseCauses(jobs),
  };
}

function summariseCauses(jobs) {
  const out = {};
  for (const job of jobs) out[job.cause] = (out[job.cause] ?? 0) + 1;
  return out;
}

/**
 * Utilisation and flake signals per runner, from completed job samples.
 * Flake rate here means "the job's run concluded as a failure", which is a
 * proxy -- a rerun of the same run id is not visible in this sample.
 */
export function runnerStats(history) {
  const byRunner = new Map();
  for (const job of history) {
    if (!job.runnerName) continue;
    const current = byRunner.get(job.runnerName) ?? { jobs: 0, failures: 0, waitS: [] };
    current.jobs++;
    if (job.conclusion === "failure") current.failures++;
    current.waitS.push(job.waitS);
    byRunner.set(job.runnerName, current);
  }

  return [...byRunner.entries()]
    .map(([name, v]) => {
      const sorted = [...v.waitS].sort((a, b) => a - b);
      return {
        name,
        jobs: v.jobs,
        failures: v.failures,
        flakeRate: v.jobs ? v.failures / v.jobs : 0,
        medianWaitS: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      };
    })
    .sort((a, b) => b.jobs - a.jobs);
}
