/**
 * The commands: what is queued and why, what the wait times look like, and what
 * a runner host is still carrying from jobs that finished.
 *
 * Each returns `{ out, code }` rather than writing to stdout itself, so that
 * every command is testable and `--json` is a formatting decision instead of a
 * second code path.
 *
 * `clean` is the only one that changes anything, and it is the reason `--apply`
 * exists. See `cmdClean` for how that is kept from being an accident.
 */
import {
  collectHistory,
  collectQueue,
  listOrgReposAll,
  listOrgRunnersAll,
} from "./github.js";
import { buildQueue, capacitySummary } from "./diagnose.js";
import {
  ConfigError,
  cacheFile,
  filterRepos,
  historyKey,
} from "./config.js";
import {
  diskUsage,
  hostIndex,
  isFresh,
  pruneWorktrees,
  readHostReports,
  removeCheckout,
  scanWorkDir,
  staleCheckouts,
} from "./hosts.js";

const round = (n) => Math.round(Number(n) || 0);
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
  // Red, and not yellow: the machine is up and has room in the queue, so
  // nothing in the Actions tab looks wrong until you go and look at the disk.
  host_disk_pressure: "red",
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
 * Reads the host reports for this run, or returns `null` when none are wanted.
 *
 * The whole lookup is optional and its failure is not fatal, because host
 * reports are an enrichment rather than a dependency: `jobs` must still answer
 * for an org where nobody has instrumented the runners. The errors are carried
 * through so the report can name the gap in its coverage instead of quietly
 * diagnosing with fewer machines than it looks.
 *
 * @returns {Promise<{ hosts: import("./hosts.js").HostIndex | null,
 *   errors: { file: string, message: string }[] }>}
 */
async function hostReportsFor(config) {
  if (!config.hostReportDir) return { hosts: null, errors: [] };
  const { reports, errors } = await readHostReports(config.hostReportDir);
  return {
    hosts: hostIndex(reports, {
      minFreePercent: config.hostDiskFreePercent,
      maxAgeMinutes: config.hostReportMaxAgeMinutes,
    }),
    errors,
  };
}

/**
 * The queue, fetched once.
 *
 * Repository listing and runner listing are independent, so they run together;
 * the queue itself needs the repo list first.
 */
async function queueFor(config) {
  const [repos, runnerData, hostData] = await Promise.all([
    scopedRepos(config),
    listOrgRunnersAll(config.orgs),
    hostReportsFor(config),
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
    hosts: hostData.hosts,
  });

  return {
    repos,
    perRepo,
    jobs,
    runners: runnerData.runners,
    unknownOrgs: runnerData.unknownOrgs,
    runnerErrors: runnerData.runnerErrors,
    hosts: hostData.hosts,
    hostErrors: hostData.errors,
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

/**
 * The host block: which runners have told us how much room they have left.
 *
 * Deliberately shows every reporting host, not only the tight ones. A host that
 * is 60% free is the evidence that the ones below the threshold are genuinely
 * in trouble, and a list containing only the failures would read as though
 * every other machine had been checked too.
 */
function hostLines(hosts, style, { maxAgeMinutes, now = Date.now() }) {
  if (!hosts) return [];
  const { reports, minFreePercent } = hosts;
  if (!reports.length) {
    return [
      style.dim(
        `Hosts  no reports in the host report directory. Jobs that look schedulable are not being checked against disk.`,
      ),
    ];
  }

  const width = Math.max(4, ...reports.map((r) => String(r.runner).length));
  const lines = [style.bold("Hosts")];

  for (const report of reports) {
    const free = report.disk?.freePercent;
    const known = typeof free === "number" && Number.isFinite(free);
    const fresh = isFresh(report, maxAgeMinutes, now);
    const label = known ? `${round(free)}% free` : "disk unknown";
    const text = `${pad(report.runner, width)}  ${pad(label, 12)}`;

    if (!fresh) {
      lines.push(`  ${style.dim(text)}  ${style.dim("(report too old to trust)")}`);
    } else if (known && free < minFreePercent) {
      lines.push(`  ${style.red(text)}  ${style.red(`under ${minFreePercent}%`)}`);
    } else {
      lines.push(`  ${text}`);
    }
  }
  return lines;
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
  // `now` is the same clock `queueFor` diagnosed with. Taken again here, the
  // host block and the causes above it could disagree about what counts as
  // stale, which is the one thing these two sections exist to agree on.
  const { json = false, style = PLAIN, now = Date.now() } = opts;
  const {
    repos,
    perRepo,
    jobs,
    runners,
    unknownOrgs,
    runnerErrors,
    unreadableRepos,
    hosts = null,
    hostErrors = [],
  } = await deps.queueFor(config);

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
          // Added, never renamed, and always present: a `hosts` key that appears
          // only when reports happen to exist makes `--json` output change shape
          // between runs, and callers have to handle both. `null` is the honest
          // value for "not looked at".
          hosts: hosts
            ? {
                minFreePercent: hosts.minFreePercent,
                maxAgeMinutes: hosts.maxAgeMinutes,
                reports: hosts.reports,
              }
            : null,
          hostErrors,
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

  const hostBlock = hostLines(hosts, style, {
    maxAgeMinutes: config.hostReportMaxAgeMinutes,
    now,
  });
  if (hostBlock.length) lines.push(...hostBlock);

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

  // An unreadable host report is a gap in the same sense: whatever it would have
  // said about disk is now simply not being claimed, and that is worth saying.
  if (hostErrors.length) {
    lines.push(
      "",
      style.yellow(
        `Host reports not read: ${hostErrors
          .map((e) => e.file)
          .join(", ")} (${hostErrors.length} report(s) could not be parsed, so disk pressure is not being checked for them)`,
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

// --- clean ----------------------------------------------------------------

/** A human-readable size. Wrong by a factor of 2^10 would not change a decision. */
function bytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let i = 0;
  while (Math.abs(value) >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/**
 * Removes stale checkouts and prunes orphaned worktrees from a runner's `_work`.
 *
 * This is the only command in the tool that deletes, and it is built so that
 * running it is harmless:
 *
 * - **Nothing is removed without `--apply`.** The default is a dry run, so the
 *   command someone types while curious cannot delete a checkout. `--apply` is
 *   deliberately an *option* and not a config setting, which means it cannot be
 *   switched on in a config file and then forgotten about.
 * - **The age threshold is checked before anything is removed**, not at the
 *   point of deletion. A directory the runner is still using has a recent
 *   mtime, so `--cleanup-age-hours` is the only thing standing between a running
 *   job and a deletion, and it defaults to a day.
 * - **Every path is resolved and checked for containment** before deletion, so a
 *   symlink inside `_work` cannot redirect it. `git worktree` creates exactly
 *   those, which makes this a real shape rather than a precaution.
 *
 * The residual risk is inherent: a job that has been running for longer than the
 * threshold will have its checkout removed underneath it. The threshold is
 * therefore documented as something to set above your longest job, not as a
 * detail.
 *
 * @param deps the filesystem operations, injectable so the presentation can be
 *   tested without a real `_work` directory. `scan` and `stats` are left real in
 *   the tests, pointed at a temporary tree, so the age arithmetic and the walk
 *   are genuinely exercised; `remove` and `pruneTrees` are stubbed, because
 *   those are the operations that must not be pointed at anything real.
 */
export async function cmdClean(config, opts = {}, deps = {}) {
  const {
    json = false,
    style = PLAIN,
    apply = false,
    prune = true,
    now = Date.now(),
    env = process.env,
  } = opts;
  const {
    scan = scanWorkDir,
    remove = removeCheckout,
    pruneTrees = pruneWorktrees,
    stats = diskUsage,
  } = deps;

  // The runner sets RUNNER_WORK itself, so on a self-hosted runner this is
  // already right without anybody configuring it. `--work-dir` overrides for the
  // case where the tool is run by hand, or against a service account's copy.
  const root = config.workDir || env.RUNNER_WORK;

  // Thrown rather than returned, so it lands on stderr with the other "you have
  // not told us something we need" messages rather than being printed as if it
  // were a result.
  if (!root) {
    throw new ConfigError(
      [
        "no work directory to clean.",
        "",
        "  Set --work-dir to a runner's _work directory, or run this on the runner",
        "  itself, where the runner exports RUNNER_WORK for every job.",
        "",
        "  runner-queue --work-dir /opt/actions-runner/_work clean",
      ].join("\n"),
    );
  }

  const found = await scan({ root, now });
  const { stale, kept } = staleCheckouts(found.checkouts, config.cleanupAgeHours);
  const disk = await stats(found.root);

  const pruned = /** @type {any[]} */ ([]);
  if (prune) {
    // Once per repository root, since that is where the worktree admin files
    // live -- not once per stale ref, which would repeat the same walk.
    const repos = new Map();
    for (const checkout of stale) repos.set(checkout.repoPath, checkout.repo);
    for (const [repoPath, repo] of repos) {
      pruned.push({ path: repoPath, repo, ...(await pruneTrees(repoPath)) });
    }
  }

  const removed = /** @type {any[]} */ ([]);
  if (apply) {
    for (const checkout of stale) {
      const result = await remove(found.root, checkout.path);
      removed.push({ ...result, rel: checkout.rel });
    }
  }

  const failures = removed.filter((r) => r.error);
  const code = failures.length ? EXIT.error : EXIT.attention;

  // The per-checkout detail, kept for `--json` so a caller can see what each
  // entry was and how old it was.
  const cleanedBy = [...stale, ...kept].map((c) => ({
    path: c.rel,
    repo: c.repo,
    ref: c.ref,
    ageHours: c.ageHours,
    stale: stale.includes(c),
  }));

  if (json) {
    return {
      out: JSON.stringify(
        {
          applied: apply,
          workDir: found.root,
          disk,
          cleanupAgeHours: config.cleanupAgeHours,
          workDirCount: found.checkouts.length,
          staleWorkDirs: stale.length,
          removedWorkDirs: removed.filter((r) => r.removed).length,
          prunedWorktrees: pruned.filter((p) => p.ok).length,
          cleanedBy,
          pruned,
          removed,
          errors: [
            ...failures.map((r) => ({ file: r.rel, message: r.error })),
            ...pruned.filter((p) => !p.ok).map((p) => ({ file: p.path, message: p.output })),
          ],
        },
        null,
        2,
      ),
      code,
    };
  }

  return {
    out: cleanText({ apply, stale, kept, pruned, removed, disk, config, style }),
    code,
  };
}

function cleanText({ apply, stale, kept, pruned, removed, disk, config, style }) {
  const lines = [];
  const verb = apply ? "Removed" : "Would remove";
  const n = stale.length;

  if (!n) {
    lines.push(
      `${style.green("Nothing to clean")} in ${config.workDir ?? "the work directory"}: ${kept.length} checkout(s), all under ${config.cleanupAgeHours}h old.`,
    );
  } else {
    lines.push(
      `${verb} ${style.bold(String(n))} checkout(s) older than ${config.cleanupAgeHours}h:`,
      "",
      ...table(
        null,
        stale.map((c) => [pad(`${c.ageHours}h`, 7), c.rel]),
      ),
    );

    // Naming what was left behind, not just a count of it. Without this, a
    // checkout that survived because it is too new to remove is invisible, and
    // the list above reads as though those were all that exist.
    if (kept.length) {
      lines.push(
        "",
        style.dim(`  Kept ${kept.length} checkout(s) under ${config.cleanupAgeHours}h old:`),
        ...table(null, kept.map((c) => [pad(`${c.ageHours}h`, 7), c.rel])).map((l) => `    ${l}`),
      );
    }
  }

  if (disk) {
    lines.push("", `  disk  ${bytes(disk.freeBytes)} free of ${bytes(disk.totalBytes)} (${round(disk.freePercent)}%)`);
  }

  const prunedOk = pruned.filter((p) => p.ok);
  if (prunedOk.length) {
    lines.push("", style.dim(`  git worktree prune ran in ${prunedOk.length} repository checkout(s).`));
  }

  const failures = removed.filter((r) => r.error);
  if (failures.length) {
    lines.push("", style.red(`  ${failures.length} removal(s) failed:`));
    for (const f of failures) lines.push(`    ${f.rel}  ${f.error}`);
  }

  if (!apply && n) {
    lines.push(
      "",
      style.yellow(`  Nothing was deleted. Re-run with --apply to remove them.`),
    );
  }

  return lines.join("\n");
}

/**
 * @typedef {object} Command
 * @property {string} summary one line for `--help`
 * @property {(config: any, opts: any, deps?: any) => Promise<{ out: string, code: number }>} run
 * @property {string[]} [accepts] the `--` options this command reads, for `--help`
 * @property {boolean} [needsOrg] false for a command that does not talk to GitHub
 * @property {string} [args] positional arguments, if the command takes any
 * @property {number} [max] most positionals accepted
 */

/** @type {Record<string, Command>} */
export const COMMANDS = {
  jobs: {
    summary: "what is queued, and why it is stuck",
    run: cmdJobs,
    accepts: [],
  },
  wait: {
    summary: "wait-time analytics from recent runs",
    run: cmdWait,
    accepts: [],
  },
  clean: {
    summary: "remove stale checkouts from a runner's _work directory",
    run: cmdClean,
    // Reads the filesystem, not GitHub. An organisation is not required, and
    // demanding one would mean `clean` could not run on the runner it is meant
    // to clean without also being configured with credentials it has no use for.
    needsOrg: false,
    accepts: ["apply", "prune"],
  },
};
