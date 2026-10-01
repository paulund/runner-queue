/**
 * Explains *why* a job is still queued. This is the difference between a
 * mirror of the GitHub Actions tab and a tool that tells you what to do.
 *
 * `runners` is threaded through so that when runner state is unavailable we
 * say "unknown" instead of guessing a cause we cannot verify. Whether a job is
 * "stuck" is a separate question, answered by the caller comparing `waitS`
 * against its own threshold, so no threshold is decided here.
 *
 * `hosts` is the same bargain one level further down: a map of runner name to
 * that host's latest disk report, or nothing at all. A missing report never
 * turns into a claim in either direction.
 */
import { freePercentFor, pressureFor } from "./hosts.js";
export function diagnoseJob(
  job,
  runners,
  {
    now = Date.now(),
    hosts = /** @type {import("./hosts.js").HostIndex | null} */ (null),
  } = {},
) {
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
    // A runner on a full disk reports itself idle and never picks the job up,
    // so "a free runner exists" is not by itself an answer. It is an answer when
    // at least one of those runners has disk to spare.
    const pressure = hostPressure(eligibleIdle, hosts, { now });
    if (pressure) {
      return {
        waitS,
        cause: "host_disk_pressure",
        detail:
          `Every free runner for this job (${names(eligibleIdle)}) is on a host ` +
          `reported out of disk (${pressure}). It will not be able to check out.`,
      };
    }
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
    const pressure = hostPressure(eligibleOnline, hosts, { now });
    if (pressure) {
      return {
        waitS,
        cause: "host_disk_pressure",
        detail:
          `Every online runner for this job (${names(eligibleOnline)}) is on a host ` +
          `reported out of disk (${pressure}). They cannot take a checkout.`,
      };
    }
    return {
      waitS,
      cause: "all_busy",
      detail: `Every online runner labelled for this job is busy: ${names(eligibleOnline)}.`,
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
      detail: `The only runners labelled for this job (${names(offline)}) are offline.`,
    };
  }

  return {
    waitS,
    cause: "label_mismatch",
    detail:
      `No runner is labelled ${needs.map((l) => `"${l}"`).join(" and ")}. ` +
      `Online runners carry: ${[...new Set(online.flatMap((r) => r.labels))].join(", ") || "none"}.`,
  };
}

const names = (runners) => runners.map((r) => r.name).join(", ");

const round = (n) => Math.round(n);

/**
 * Names the disk state shared by a set of runners, or returns `null` if the set
 * cannot be called uniformly tight.
 *
 * Two conditions have to hold. Every runner in the set has to be *reported* as
 * low, and there has to be at least one report -- otherwise a single
 * uninstrumented machine in the set would be reported as though we had checked
 * it. `pressureFor` is tri-state precisely so that "no report" and "reported
 * healthy" cannot be collapsed into one another.
 */
function hostPressure(runners, hosts, { now }) {
  if (!hosts || !runners.length) return null;
  if (!runners.every((r) => pressureFor(r, hosts, { now }) === true)) return null;
  const free = round(freePercentFor(runners[0], hosts) ?? 0);
  return runners.length === 1 ? `${free}% free` : `${free}% free on each host`;
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
  {
    now = Date.now(),
    unknownOrgs = new Set(),
    // `buildQueue` is the boundary between the two halves of the tool, and is
    // where a null has to be allowed through: no host reports is the normal case
    // for anyone who has not instrumented their runners.
    hosts = /** @type {import("./hosts.js").HostIndex | null} */ (null),
  } = {},
) {
  const jobs = [];

  for (const repo of perRepo) {
    // An org with unreadable runner state is diagnosed as unknown, even when
    // other orgs in the same run reported theirs.
    const repoRunners = runners === null || unknownOrgs.has(repo.org) ? null : runnersForOrg(runners, repo.org);

    for (const { run, jobs: runJobs } of repo.queued) {
      for (const job of runJobs) {
        const diag = diagnoseJob(job, repoRunners, { now, hosts });
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

