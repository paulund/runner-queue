/**
 * The two commands: what is queued and why, and what the wait times look like.
 *
 * Each returns `{ out, code }` rather than writing to stdout itself, so that
 * every command is testable and `--json` is a formatting decision instead of a
 * second code path.
 */
import {
  collectHistory,
  collectQueue,
  listOrgReposAll,
  listOrgRunnersAll,
} from "./github.js";
import { buildQueue, capacitySummary } from "./diagnose.js";
import {
  cacheFile,
  filterRepos,
  historyKey,
} from "./config.js";
import { EXIT } from "./errors.js";
import { PLAIN, duration, pad, table } from "./format.js";

/**
 * How each cause is coloured: what is broken versus what is merely slow. A
 * `scheduling` job is a runner about to pick something up, so it is not the
 * same kind of news as a job nothing can ever run.
 */
const CAUSE_COLOUR = {
  scheduling: "green",
  all_busy: "yellow",
  runner_offline: "yellow",
  no_runners_online: "red",
  label_mismatch: "red",
  unknown_capacity: "dim",
};

const orList = (orgs) => orgs.join(", ");

const orgWidth = (orgs) => Math.max(4, ...orgs.map((o) => String(o).length));

const cause = (value, style) => style[CAUSE_COLOUR[value] ?? "dim"](value);

/** The repositories in scope, after the org, archive and repo filters. */
async function scopedRepos(config) {
  const repos = await listOrgReposAll(config.orgs, {
    includeArchived: config.includeArchived,
  });
  return filterRepos(repos, config);
}

/**
 * The queue, fetched once.
 *
 * Repository listing and runner listing are independent, so they run together;
 * the queue itself needs the repo list first.
 */
async function queueFor(config) {
  const [repos, runnerData] = await Promise.all([
    scopedRepos(config),
    listOrgRunnersAll(config.orgs),
  ]);

  // One clock for the whole report. Taking the time separately for the fetch
  // and again for the diagnosis can put a job over the threshold between the
  // two, and the output would then disagree with itself.
  const now = Date.now();

  const perRepo = await collectQueue(repos, {
    concurrency: config.concurrency,
    runPages: config.queueRunPages,
  });

  const jobs = buildQueue(perRepo, runnerData.runners, {
    now,
    unknownOrgs: runnerData.unknownOrgs,
  });

  return {
    repos,
    perRepo,
    jobs,
    runners: runnerData.runners,
    unknownOrgs: runnerData.unknownOrgs,
    runnerErrors: runnerData.runnerErrors,
    // Repositories that could not be read at all, so the report can name the
    // gap in its coverage instead of quietly looking smaller.
    unreadableRepos: perRepo.filter((r) => r.error).map((r) => r.repo),
  };
}

async function historyFor(config, repos) {
  return collectHistory(repos ?? (await scopedRepos(config)), {
    days: config.historyDays,
    sample: config.historySample,
    concurrency: config.concurrency,
    cachePath: cacheFile(config),
    cacheKey: historyKey(config),
  });
}

/** The runner block, so a queue with no free runner says so. */
function capacityLines(orgs, runners, unknownOrgs, runnerErrors, style) {
  const cap = capacitySummary(runners);
  const names = [
    ...(cap?.perOrg ?? []).map((p) => p.org),
    ...[...unknownOrgs],
  ];
  const width = orgWidth(names.length ? names : [""]);

  // No runners and no permission problem: the organisation genuinely has none.
  if (!cap?.total && !runnerErrors.length) {
    return [`${style.bold("Runners")}  none registered on ${orList(orgs)}`];
  }

  const lines = [style.bold("Runners")];
  for (const per of cap?.perOrg ?? []) {
    lines.push(
      `  ${pad(per.org, width)}  ${per.idle} free, ${per.busy} busy, ${per.offline} offline (${per.total} total)`,
    );
  }
  for (const err of runnerErrors) {
    lines.push(`  ${pad(err.org, width)}  ${err.message}`);
    if (err.fix) lines.push(`  ${" ".repeat(width)}  ${style.cyan(`fix: ${err.fix}`)}`);
  }
  return lines;
}

// --- jobs -----------------------------------------------------------------

/**
 * @param deps the data sources, injectable so the presentation can be tested
 *   without a network or a credential.
 */
export async function cmdJobs(config, opts = {}, deps = { queueFor }) {
  const { json = false, style = PLAIN } = opts;
  const { repos, perRepo, jobs, runners, unknownOrgs, runnerErrors, unreadableRepos } =
    await deps.queueFor(config);

  const thresholdS = config.thresholdMinutes * 60;
  const stuck = jobs.filter((j) => j.waitS >= thresholdS);
  const inProgressRuns = perRepo.reduce((n, r) => n + r.inProgress.length, 0);
  const code = stuck.length ? EXIT.attention : EXIT.ok;

  if (json) {
    return {
      out: JSON.stringify(
        {
          orgs: config.orgs,
          generatedAt: new Date().toISOString(),
          thresholdMinutes: config.thresholdMinutes,
          summary: {
            queuedJobs: jobs.length,
            queuedRuns: perRepo.reduce((n, r) => n + r.queued.length, 0),
            inProgressRuns,
            stuckJobs: stuck.length,
            reposInScope: repos.length,
            reposWithQueuedJobs: new Set(jobs.map((j) => j.repo)).size,
            oldestWaitS: jobs.length ? jobs[0].waitS : 0,
          },
          capacity: capacitySummary(runners),
          unknownOrgs: [...unknownOrgs],
          runnerErrors,
          unreadableRepos,
          jobs,
        },
        null,
        2,
      ),
      code,
    };
  }

  if (!jobs.length) {
    return {
      out: `The queue is empty. Nothing in ${orList(config.orgs)} is waiting for a runner.`,
      code: EXIT.ok,
    };
  }

  const worst = jobs[0];
  // Repositories holding queued work, not repositories in scope: "3 jobs across
  // 40 repos" reads as though 40 repos have something waiting.
  const busyRepos = new Set(jobs.map((j) => j.repo)).size;
  const lines = [
    `${style.bold(String(jobs.length))} job(s) queued across ${busyRepos} repo(s) in ${orList(config.orgs)}.`,
    "",
    `${style.bold("Worst")}  ${worst.repo}  ${worst.branch} → ${worst.jobName}`,
    `       waiting ${style.bold(duration(worst.waitS))}`,
    `       cause   ${cause(worst.cause, style)}`,
    `       ${worst.detail}`,
  ];

  if (stuck.length > 1) {
    lines.push("", style.bold(`All ${stuck.length} jobs over ${config.thresholdMinutes}m:`));
    const rows = stuck.map((j) => [
      pad(duration(j.waitS), 9),
      `${j.repo}  ${j.branch}  ${j.jobName}`,
      cause(j.cause, style),
    ]);
    for (const line of table(["waiting", "run", "cause"], rows)) {
      lines.push(`  ${line}`);
    }
  }

  // Say what the table left out. A count of 11 above a list of 8, with no
  // explanation, reads as eight jobs having gone missing.
  const fresh = jobs.length - stuck.length;
  if (fresh > 0) {
    lines.push(
      "",
      style.dim(
        `${fresh} job(s) also queued, all under the ${config.thresholdMinutes}m threshold.`,
      ),
    );
  }

  lines.push("", ...capacityLines(config.orgs, runners, unknownOrgs, runnerErrors, style));

  // Coverage gaps are reported, never hidden. A queue that looks short because
  // one repository could not be read is worse than no answer at all.
  if (unreadableRepos.length) {
    lines.push(
      "",
      style.yellow(
        `Not read: ${unreadableRepos.join(", ")} (${unreadableRepos.length} repo(s) could not be listed, so the queue above is incomplete)`,
      ),
    );
  }

  return { out: lines.join("\n"), code };
}

// --- wait -----------------------------------------------------------------

export async function cmdWait(config, opts = {}, deps = { historyFor }) {
  const { json = false, style = PLAIN } = opts;
  const history = await deps.historyFor(config);

  if (json) {
    return {
      out: JSON.stringify({ orgs: config.orgs, ...history }, null, 2),
      code: EXIT.ok,
    };
  }

  const o = history.overall;
  const ttg = history.timeToGreen;

  if (!o.n) {
    return {
      out: [
        `No completed runs with started jobs in the last ${config.historyDays} day(s).`,
        "",
        "Nothing to measure yet. Check the org and repo filters, or widen the window with",
        "--history-days.",
      ].join("\n"),
      code: EXIT.ok,
    };
  }

  return {
    out: [
      `Wait times over the last ${history.daily.length} day(s) with completed runs, ${o.n} job samples from ${history.byRepo.length} repo(s).${history.cached ? "  (cached)" : ""}`,
      "",
      `  median wait   ${duration(o.p50)}`,
      `  p90 wait      ${duration(o.p90)}   ${style.dim(`(n=${o.n})`)}`,
      `  worst wait    ${duration(o.max)}`,
      "",
      `  median run    ${duration(ttg.p50)} created to finished`,
      `  queue share   ${(ttg.waitShare * 100).toFixed(0)}% of that is queue wait`,
      "",
      `  blocked CI    ${history.blockedHours.totalHours.toFixed(0)} job-hours across ${history.blockedHours.days} day(s)`,
      "",
      style.bold("Worst workflows:"),
      ...history.workflows
        .slice(0, 6)
        .map((w) => `  ${pad(duration(w.p90), 9)} p90  n=${pad(w.n, 4)}  ${w.repo} ${w.workflow}`),
    ].join("\n"),
    code: EXIT.ok,
  };
}

export const COMMANDS = {
  jobs: { summary: "what is queued, and why it is stuck", run: cmdJobs },
  wait: { summary: "wait-time analytics from recent runs", run: cmdWait },
};
