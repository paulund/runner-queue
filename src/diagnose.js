/**
 * Explains *why* a job is still queued. This is the difference between a
 * mirror of the GitHub Actions tab and a tool that tells you what to do.
 *
 * `runners` is threaded through so that when runner state is unavailable we
 * say "unknown" instead of guessing a cause we cannot verify. Whether a job is
 * "stuck" is a separate question, answered by the caller comparing `waitS`
 * against its own threshold, so no threshold is decided here.
 */
export function diagnoseJob(job, runners, { now = Date.now() } = {}) {
  const waitS = Math.max(
    0,
    (now - new Date(job.created_at).getTime()) / 1000,
  );
  const needs = job.labels ?? [];
  const hasRunnerState = runners !== null;

  if (!hasRunnerState) {
    return {
      waitS,
      cause: "unknown_capacity",
      detail:
        "Waiting. Runner capacity is unknown, so the cause cannot be determined.",
    };
  }

  const online = runners.filter((r) => r.status === "online");

  // Only runners that are actually online can be said to be "busy"; an
  // offline runner matching the labels means nothing is available, not that
  // something is occupied.
  const eligible = runners.filter((r) => matchesLabels(r, needs));
  const eligibleOnline = eligible.filter((r) => r.status === "online");
  const eligibleIdle = eligibleOnline.filter((r) => !r.busy);

  if (eligibleIdle.length > 0) {
    return {
      waitS,
      cause: "scheduling",
      detail:
        eligibleIdle.length === 1
          ? `A free runner is labelled for this job (${eligibleIdle[0].name}); it has not been picked up yet.`
          : `${eligibleIdle.length} free runners are labelled for this job.`,
    };
  }

  if (eligibleOnline.length > 0) {
    return {
      waitS,
      cause: "all_busy",
      detail: `Every online runner labelled for this job is busy: ${eligibleOnline
        .map((r) => r.name)
        .join(", ")}.`,
    };
  }

  if (online.length === 0) {
    return {
      waitS,
      cause: "no_runners_online",
      detail:
        "No self-hosted runners are online. The jobs that need labels " +
        `${needs.join(", ")} have nothing to run on.`,
    };
  }

  // Reaching here means some runners are online, but none of the ones this job
  // needs are. So the question is only whether such runners exist at all: if
  // they do they are the ones that are offline, and the fix is to switch a
  // machine on rather than to relabel anything.
  //
  // Comparing the eligible count against the online count instead -- which is
  // what this used to do -- gets that wrong whenever an org has more runners
  // online than the job needs offline, and reports a perfectly good macOS job
  // as a label problem.
  const offline = eligible.filter((r) => r.status !== "online");
  if (eligible.length > 0 && offline.length === eligible.length) {
    return {
      waitS,
      cause: "runner_offline",
      detail: `The only runners labelled for this job (${offline
        .map((r) => r.name)
        .join(", ")}) are offline.`,
    };
  }

  return {
    waitS,
    cause: "label_mismatch",
    detail:
      `No runner is labelled ${needs.map((l) => `"${l}"`).join(" and ")}. ` +
      `Online runners carry: ${online
        .flatMap((r) => r.labels)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(", ") || "none"}.`,
  };
}

/**
 * GitHub matching: a job's `runs-on` array is an AND of label requirements;
 * `self-hosted` is implied by any other self-hosted label.
 */
export function matchesLabels(runner, needs) {
  if (!needs.length) return true;
  const has = (l) => runner.labels.includes(l);
  return needs.every((n) => (n === "self-hosted" ? true : has(n)));
}

/**
 * Flattens a queue across repositories into one list, longest wait first.
 *
 * `runners` is either `null` -- no capacity data at all -- or a flat list of
 * runners each carrying the org they belong to. Runners are org-scoped on
 * GitHub, so a job in one org can only ever be served by that org's runners;
 * `unknownOrgs` names the orgs whose runner list could not be read, which is
 * what lets one org's missing scope stay local to that org.
 */
export function buildQueue(
  perRepo,
  runners,
  { now = Date.now(), unknownOrgs = new Set() } = {},
) {
  const jobs = [];

  for (const repo of perRepo) {
    // An org with unreadable runner state is diagnosed as unknown, even when
    // other orgs in the same run reported theirs.
    const repoRunners = runners === null || unknownOrgs.has(repo.org) ? null : runnersForOrg(runners, repo.org);

    for (const { run, jobs: runJobs } of repo.queued) {
      for (const job of runJobs) {
        const diag = diagnoseJob(job, repoRunners, { now });
        jobs.push({
          org: repo.org,
          repo: repo.repo,
          runId: run.id,
          runName: run.name,
          runNumber: run.run_number,
          event: run.event,
          branch: run.head_branch,
          headSha: run.head_sha ?? null,
          url: run.html_url,
          jobId: job.id,
          jobName: job.name,
          labels: job.labels ?? [],
          createdAt: job.created_at,
          ...diag,
        });
      }
    }
  }

  jobs.sort((a, b) => b.waitS - a.waitS);
  return jobs;
}

/**
 * The runners one org can use. An org-less runner is treated as a candidate for
 * every org, so a single-organisation call site does not have to label its
 * runners before asking.
 */
export function runnersForOrg(runners, org) {
  if (!org) return runners;
  return runners.filter((r) => !r.org || r.org === org);
}

/** Counts across a fleet, with a per-organisation breakdown. */
export function capacitySummary(runners) {
  if (!runners) return null;
  const online = runners.filter((r) => r.status === "online");
  return {
    total: runners.length,
    online: online.length,
    busy: runners.filter((r) => r.busy).length,
    idle: online.filter((r) => !r.busy).length,
    offline: runners.filter((r) => r.status !== "online").length,
    lanes: runners.map((r) => ({
      org: r.org ?? null,
      name: r.name,
      os: r.os,
      status: r.status,
      busy: r.busy,
      labels: r.labels,
      ephemeral: r.ephemeral,
    })),
    perOrg: summariseOrgs(runners),
  };
}

/**
 * Counts per organisation. Runners belong to one org, so a queue that spans
 * several needs each of them accounted for separately rather than in one
 * total that hides which machine is short.
 */
function summariseOrgs(runners) {
  const groups = new Map();
  for (const runner of runners) {
    const org = runner.org ?? "";
    if (!groups.has(org)) groups.set(org, []);
    groups.get(org).push(runner);
  }

  return [...groups.entries()]
    .map(([org, list]) => {
      const online = list.filter((r) => r.status === "online");
      return {
        org,
        total: list.length,
        online: online.length,
        busy: list.filter((r) => r.busy).length,
        idle: online.filter((r) => !r.busy).length,
        offline: list.filter((r) => r.status !== "online").length,
      };
    })
    .sort((a, b) => a.org.localeCompare(b.org));
}

