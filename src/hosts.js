/**
 * The runner host's own filesystem: the work directories it is sitting on.
 *
 * This is the one place in the tool that looks at something other than the
 * GitHub API, and it exists because a runner host fills up. GitHub does not
 * report a full disk through any endpoint; the machine simply keeps accepting
 * jobs and failing them, or stops being picked at all.
 *
 * Everything destructive in the tool goes through here, so the safety rules are
 * stated once rather than at each call site.
 */
import { execFile } from "node:child_process";
import { readdir, realpath, rm, stat, statfs } from "node:fs/promises";
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

const run = promisify(execFile);

/**
 * Directories inside `_work` that belong to the runner rather than to a job's
 * checkout. They are never candidates for removal: `_temp` in particular holds
 * the payload of a job that may be mid-transfer, and deleting it would corrupt
 * a run rather than tidy one.
 */
const RESERVED = new Set(["_temp", "_actions", "_diag", "_logs", "_runner_file_commands"]);

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
