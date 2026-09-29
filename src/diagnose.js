/**
 * Explains *why* a job is still queued. This is the difference between a
 * mirror of the GitHub Actions tab and a tool that tells you what to do.
 *
 * `runnerError` is threaded through so that when runner state is unavailable
 * we say "unknown" instead of guessing a cause we cannot verify.
 */
export function diagnoseJob(job, runners, { now = Date.now(), thresholdS = 600 } = {}) {
  const waitS = Math.max(
    0,
    (now - new Date(job.created_at).getTime()) / 1000,
  );
  const needs = job.labels ?? [];
  const hasRunnerState = runners !== null;

  if (!hasRunnerState) {
    return {
      waitS,
      severity: waitS >= thresholdS ? "signal" : "muted",
      cause: "unknown_capacity",
      detail:
        "Waiting. Runner capacity is unknown, so the cause cannot be determined.",
    };
  }

  const online = runners.filter((r) => r.status === "online");
  const onlineIdle = online.filter((r) => !r.busy);

  // Only runners that are actually online can be said to be "busy"; an
  // offline runner matching the labels means nothing is available, not that
  // something is occupied.
  const eligible = runners.filter((r) => matchesLabels(r, needs));
  const eligibleOnline = eligible.filter((r) => r.status === "online");
  const eligibleIdle = eligibleOnline.filter((r) => !r.busy);

  if (eligibleIdle.length > 0) {
    return {
      waitS,
      severity: waitS >= thresholdS ? "signal" : "muted",
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
      severity: "warn",
      cause: "all_busy",
      detail: `Every online runner labelled for this job is busy: ${eligibleOnline
        .map((r) => r.name)
        .join(", ")}.`,
    };
  }

  if (online.length === 0) {
    return {
      waitS,
      severity: "signal",
      cause: "no_runners_online",
      detail:
        "No self-hosted runners are online. The jobs that need labels " +
        `${needs.join(", ")} have nothing to run on.`,
    };
  }

  if (eligible.length > online.length && eligible.some((r) => r.status !== "online")) {
    return {
      waitS,
      severity: "warn",
      cause: "runner_offline",
      detail: `The only runners labelled for this job (${eligible
        .filter((r) => r.status !== "online")
        .map((r) => r.name)
        .join(", ")}) are offline.`,
    };
  }

  return {
    waitS,
    severity: "warn",
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

export function buildQueue(perRepo, runners, { now = Date.now(), thresholdS = 600 } = {}) {
  const jobs = [];

  for (const repo of perRepo) {
    for (const { run, jobs: runJobs } of repo.queued) {
      for (const job of runJobs) {
        const diag = diagnoseJob(job, runners, { now, thresholdS });
        jobs.push({
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
      name: r.name,
      os: r.os,
      status: r.status,
      busy: r.busy,
      labels: r.labels,
      ephemeral: r.ephemeral,
    })),
  };
}
