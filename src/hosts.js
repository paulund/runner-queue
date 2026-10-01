/**
 * The runner host's own filesystem: the work directories it is sitting on, and
 * the host reports that say how much room is left on them.
 *
 * This is the one place in the tool that looks at something other than the
 * GitHub API, and it exists because a full disk is invisible from outside. A
 * runner with no space reports itself online, may report itself idle, and the
 * job it was supposed to pick up simply never runs. Reading the host is how
 * that stops being a mystery.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, rm, stat, statfs } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

/**
 * The filesystem calls this module makes, all overridable so the decisions can
 * be tested against a made-up `_work` directory instead of a real one.
 *
 * @typedef {object} Io
 * @property {(path: string, opts?: any) => Promise<any>} [readdir]
 * @property {(path: string) => Promise<any>} [stat]
 * @property {(path: string) => Promise<string>} [realpath]
 * @property {(path: string, opts?: any) => Promise<void>} [rm]
 */

/**
 * Reports keyed by the runner they describe, with the thresholds to read them
 * against.
 *
 * @typedef {object} HostIndex
 * @property {Map<string, any>} index reports by runner name
 * @property {any[]} reports the reports as read, in file-name order
 * @property {number} minFreePercent free disk percent below which a host is tight
 * @property {number} maxAgeMinutes how old a report may be and still be believed
 */

const run = promisify(execFile);

/**
 * Directories inside `_work` that belong to the runner rather than to a job's
 * checkout. They are never candidates for removal: `_temp` in particular holds
 * the payload of a job that may be mid-transfer, and deleting it would corrupt
 * a run rather than tidy one.
 */
const RESERVED = new Set(["_temp", "_actions", "_diag", "_logs", "_runner_file_commands"]);

// --- host reports ---------------------------------------------------------

/**
 * Reads every `*.json` report in a directory.
 *
 * A missing directory is reported rather than thrown, for the same reason an
 * unreadable repository is: a host that has not reported yet is a gap in the
 * evidence, and the queue report is still worth printing without it. What it
 * must not do is quietly present "no reports" as "no disk problems".
 *
 * @param {string} dir
 * @returns {Promise<{ reports: any[], errors: { file: string, message: string }[] }>}
 */
export async function readHostReports(dir) {
  if (!dir) return { reports: [], errors: [] };

  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    return {
      reports: [],
      errors: [
        {
          file: dir,
          message: `could not read host report directory: ${err.code ?? err.message}`,
        },
      ],
    };
  }

  const reports = [];
  const errors = [];

  for (const name of entries.filter((e) => e.endsWith(".json")).sort()) {
    try {
      const report = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (!report || typeof report !== "object" || Array.isArray(report)) {
        throw new Error("not a JSON object");
      }
      // The file name is the runner name. A report that does not name itself is
      // unusable, because nothing else can attribute it to a machine.
      reports.push({ ...report, runner: report.runner ?? name.replace(/\.json$/, "") });
    } catch (err) {
      errors.push({ file: name, message: err.message });
    }
  }

  return { reports, errors };
}

/**
 * Packages reports with the thresholds they should be read against.
 *
 * The thresholds travel with the reports rather than being passed alongside at
 * every call site, because the two are only ever meaningful together: a report
 * judged against somebody else's free-space limit is not a fact.
 *
 * @param {any[]} reports
 * @param {{ minFreePercent?: number, maxAgeMinutes?: number }} [thresholds]
 * @returns {HostIndex}
 */
export function hostIndex(reports, { minFreePercent = 5, maxAgeMinutes = 30 } = {}) {
  const index = new Map();
  for (const report of reports ?? []) {
    if (report?.runner) index.set(report.runner, report);
  }
  return { index, reports: reports ?? [], minFreePercent, maxAgeMinutes };
}

/** Reads a report back out by runner name, tolerating an absent index. */
export const hostReportFor = (hosts, name) => hosts?.index?.get(name) ?? null;

/**
 * Whether a report says the disk is too full to be trusted with another
 * checkout.
 *
 * Compared against a percentage rather than an absolute byte count, because the
 * hosts in one org are not all the same size and a fixed number would flag a
 * large disk as healthy and a small one as failing at the same moment.
 */
export function diskPressure(report, minFreePercent) {
  const free = report?.disk?.freePercent;
  if (typeof free !== "number" || !Number.isFinite(free)) return false;
  return free < minFreePercent;
}

/**
 * Whether a report can still be believed.
 *
 * A stale report is worse than none. One written an hour ago saying the disk is
 * 90% free, when the disk filled up since, would turn a plain `scheduling`
 * answer into a confident wrong one -- which is the failure mode this tool
 * exists to avoid, so an old report is treated as no report.
 */
export function isFresh(report, maxAgeMinutes, now = Date.now()) {
  if (typeof report?.at !== "string") return false;
  const at = new Date(report.at).getTime();
  if (!Number.isFinite(at)) return false;
  const ageMs = now - at;
  return ageMs >= 0 && ageMs <= maxAgeMinutes * 60_000;
}

/**
 * Whether a runner is known to be out of disk.
 *
 * Three-valued on purpose: a runner with no report, or a stale one, is `null`
 * rather than `false`. The diagnosis needs the difference between "reported
 * healthy" and "never asked", or it will report a confident cause for every job
 * on a host nobody has instrumented.
 */
export function pressureFor(runner, hosts, { now = Date.now() } = {}) {
  const report = hostReportFor(hosts, runner?.name);
  if (!report || !isFresh(report, hosts.maxAgeMinutes, now)) return null;
  return diskPressure(report, hosts.minFreePercent);
}

/** Free disk percent as reported, or `null` when there is nothing to report. */
export function freePercentFor(runner, hosts) {
  const free = hostReportFor(hosts, runner?.name)?.disk?.freePercent;
  return typeof free === "number" && Number.isFinite(free) ? free : null;
}

// --- disk -----------------------------------------------------------------

/**
 * How much room is left where the work directory lives. `bavail` rather than
 * `bfree` because the root-reserved blocks belong to the filesystem, not to the
 * runner, and cannot be spent on a checkout.
 */
export async function diskUsage(path) {
  try {
    const { bsize, blocks, bavail } = await statfs(path);
    const totalBytes = bsize * blocks;
    const freeBytes = bsize * bavail;
    return {
      totalBytes,
      freeBytes,
      freePercent: totalBytes ? (freeBytes / totalBytes) * 100 : 0,
    };
  } catch {
    // A host without `statfs` is unusual but not worth failing a cleanup over;
    // the report simply carries no disk figures.
    return null;
  }
}

/**
 * Builds the report `clean --report` writes and `jobs --host-report-dir` reads.
 * The same shape both ways, deliberately: one side produces it and the other
 * consumes it, and two shapes would mean a conversion to keep in step.
 *
 * Carries counts, not a list of the directories it found. A report is written
 * *after* the removals, so an inventory taken beforehand describes directories
 * that no longer exist -- and `jobs` reads this to judge whether a disk is full,
 * where a stale inventory is worse than none.
 *
 * @param {{ runner?: string | null, hostname?: string | null, root?: string | null,
 *   disk?: any, checkouts?: any[], stale?: any[], removed?: any[],
 *   pruned: number, errors?: any[], now?: number }} input
 */
export function hostReport({
  runner,
  hostname,
  root,
  disk,
  checkouts = [],
  stale = [],
  removed = [],
  pruned = 0,
  errors = [],
  now = Date.now(),
}) {
  return {
    // Falls back to the hostname, so a report written by hand outside a runner
    // is still attributable -- which is the only thing that makes it matchable.
    runner: runner ?? hostname ?? null,
    hostname: hostname ?? null,
    // What makes staleness detectable on the reading side.
    at: new Date(now).toISOString(),
    workDir: root ?? null,
    disk: disk ?? null,
    workDirCount: checkouts.length,
    staleWorkDirs: stale.length,
    removedWorkDirs: removed.filter((r) => r.removed).length,
    prunedWorktrees: pruned,
    errors,
  };
}

// --- scanning -------------------------------------------------------------

/** True when `child` is inside `root`. Both are expected to be resolved. */
function within(root, child) {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/**
 * Age in whole hours, used to decide staleness.
 *
 * Rounded *down*, and that is the safety-relevant direction. A checkout is
 * removed at `ageHours >= minAgeHours`, so rounding up would make a directory
 * that is 23h 59m old report 24 and be deleted one minute before the threshold
 * the command prints. Flooring means the displayed age and the comparison it
 * came from always agree, and nothing goes early.
 */
const ageHours = (mtimeMs, now) => Math.floor(Math.max(0, now - mtimeMs) / 3_600_000);

/**
 * Finds the work directories under a runner's `_work`.
 *
 * The layout is `<_work>/<owner>/<repo>/<ref>`, so this walks exactly two levels
 * and reports what it finds rather than trying to judge it. Whether an entry is
 * old enough to remove is a separate question, answered by `staleCheckouts`, so
 * that everything reaching the delete call has already passed the threshold.
 *
 * @param {{ root: string, now?: number, fs?: Io }} options
 * @returns {Promise<{ root: string, checkouts: any[] }>}
 */
export async function scanWorkDir({ root, now = Date.now(), fs: io = {} }) {
  const readDir = io.readdir ?? readdir;
  const lstat = io.stat ?? stat;
  const resolveReal = io.realpath ?? realpath;

  let rootReal;
  try {
    rootReal = await resolveReal(root);
  } catch (err) {
    throw Object.assign(new Error(`no such work directory: ${root}`), {
      kind: "config",
      code: err.code,
    });
  }

  const checkouts = [];

  let owners;
  try {
    owners = await readDir(rootReal, { withFileTypes: true });
  } catch (err) {
    throw Object.assign(new Error(`could not read ${rootReal}: ${err.code ?? err.message}`), {
      kind: "config",
    });
  }

  for (const owner of owners) {
    if (!owner.isDirectory() || RESERVED.has(owner.name)) continue;
    let repos;
    try {
      repos = await readDir(join(rootReal, owner.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const repo of repos) {
      if (!repo.isDirectory()) continue;
      const repoPath = join(rootReal, owner.name, repo.name);
      let refs;
      try {
        refs = await readDir(repoPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ref of refs) {
        if (!ref.isDirectory() || RESERVED.has(ref.name)) continue;
        const path = join(repoPath, ref.name);
        let info;
        try {
          info = await lstat(path);
        } catch {
          continue;
        }
        if (!info.isDirectory()) continue;
        checkouts.push({
          path,
          // The repository root above this ref. `git worktree prune` has to run
          // there rather than in the ref directory, because that is where the
          // administrative files it tidies up are kept.
          repoPath,
          rel: relative(rootReal, path),
          repo: `${owner.name}/${repo.name}`,
          ref: ref.name,
          mtimeMs: info.mtimeMs,
          ageHours: ageHours(info.mtimeMs, now),
        });
      }
    }
  }

  return { root: rootReal, checkouts };
}

/**
 * The checkouts old enough to be leftovers, and why the rest were kept.
 *
 * The age test is the only safety there is, which is why it is applied here
 * rather than at the point of deletion: a directory the runner is still using
 * has a recent mtime, so this threshold is the only thing standing between a
 * running job and a deletion.
 */
export function staleCheckouts(checkouts, minAgeHours) {
  const stale = [];
  const kept = [];
  for (const checkout of checkouts) {
    (checkout.ageHours >= minAgeHours ? stale : kept).push(checkout);
  }
  return { stale, kept };
}

// --- deletion -------------------------------------------------------------

/**
 * Removes a checkout, refusing anything that is not inside the work root.
 *
 * The path is resolved first and the containment check happens against the
 * resolved value, so a symlink inside `_work` cannot be used to point the
 * deletion somewhere else. `git worktree` makes exactly these symlinks, so this
 * is a real shape rather than a theoretical one.
 *
 * @param {string} root resolved work directory root
 * @param {string} path the checkout to remove
 * @param {{ fs?: Io }} [options]
 * @returns {Promise<{ removed: boolean, path: string, error?: string }>}
 */
export async function removeCheckout(root, path, { fs: io = {} } = {}) {
  const resolveReal = io.realpath ?? realpath;
  const remove = io.rm ?? rm;

  let real;
  try {
    real = await resolveReal(path);
  } catch (err) {
    return { removed: false, path, error: err.code ?? err.message };
  }
  if (!within(root, real) || real === root) {
    return { removed: false, path, error: "refused: resolves outside the work directory" };
  }
  try {
    await remove(real, { recursive: true, force: true });
    return { removed: true, path: real };
  } catch (err) {
    return { removed: false, path: real, error: err.code ?? err.message };
  }
}

/**
 * Runs `git worktree prune` in one checkout.
 *
 * This is git's own housekeeping for administrative files whose directory is
 * gone -- the records it leaves behind when a checkout is deleted out from
 * under it. It does not itself delete any working tree, which is why callers
 * report it separately from the removals rather than folding it in with them.
 */
export async function pruneWorktrees(path, { exec = run, timeout = 20_000 } = {}) {
  try {
    const { stdout, stderr } = await exec("git", ["worktree", "prune", "--verbose"], {
      cwd: path,
      timeout,
    });
    return { ok: true, output: `${stdout ?? ""}${stderr ?? ""}`.trim() };
  } catch (err) {
    return { ok: false, output: String(err?.stderr ?? err?.message ?? err).trim() };
  }
}
