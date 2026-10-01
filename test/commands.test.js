import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, OPTIONS } from "../src/args.js";
import { COMMANDS, cmdClean, cmdJobs, cmdWait } from "../src/commands.js";
import { SCHEMA, loadConfig } from "../src/config.js";
import { EXIT } from "../src/errors.js";

/**
 * Both commands talk to GitHub, so their presentation is tested by injecting
 * the data they would have fetched. That covers the parts worth covering --
 * what gets printed, and what exit code comes out -- without a network or a
 * credential.
 */

/**
 * A config with no file anywhere. The environment is built rather than spread
 * from `process.env`, so a developer's own `RUNNER_QUEUE_*` variables and their
 * real `~/.config` cannot change what these tests assert.
 */
const config = async (over = {}) => {
  const home = await mkdtemp(join(tmpdir(), "rq-cmd-"));
  return {
    ...(await loadConfig({
      cwd: home,
      env: { XDG_CONFIG_HOME: join(home, "xdg"), HOME: home },
      flags: new Map(),
    })),
    orgs: ["acme"],
    ...over,
  };
};

const job = (over = {}) => ({
  org: "acme",
  repo: "acme/api",
  runId: 1,
  runName: "CI",
  runNumber: 1,
  event: "push",
  branch: "main",
  headSha: "abc123",
  url: "https://example.invalid/runs/1",
  jobId: 11,
  jobName: "build",
  labels: ["self-hosted"],
  createdAt: "2026-01-01T00:00:00Z",
  waitS: 3600,
  cause: "all_busy",
  detail: "Every online runner labelled for this job is busy: r1.",
  ...over,
});

/**
 * Stands in for `queueFor`, so it returns what the real one does: jobs already
 * ordered longest-wait-first by `buildQueue`. The commands rely on that order
 * when they pick the worst job, and a fake that sorted differently would be
 * testing a situation that cannot happen.
 */
const queue = (jobs, over = {}) => ({
  repos: [{ org: "acme", name: "api", full_name: "acme/api" }],
  perRepo: [{ org: "acme", repo: "acme/api", queued: [], inProgress: [] }],
  jobs: [...jobs].sort((a, b) => b.waitS - a.waitS),
  runners: [
    { org: "acme", id: 1, name: "r1", os: "linux", status: "online", busy: true, labels: ["self-hosted"], ephemeral: false },
  ],
  unknownOrgs: new Set(),
  runnerErrors: [],
  unreadableRepos: [],
  ...over,
});

const history = (over = {}) => ({
  overall: { n: 3, p50: 60, p90: 900, max: 1800, mean: 400 },
  byRepo: [{ repo: "acme/api", n: 3, p50: 60, p90: 900, max: 1800, mean: 400 }],
  workflows: [{ repo: "acme/api", workflow: "CI", n: 3, p50: 60, p90: 900, max: 1800, mean: 400 }],
  daily: [{ day: "2026-01-01", n: 3, p50: 60, p90: 900, max: 1800, mean: 400 }],
  failures: 0,
  timeToGreen: { n: 1, p50: 600, p90: 600, max: 600, mean: 600, waitShare: 0.5, samples: [] },
  blockedHours: { series: [], totalHours: 2, days: 1 },
  samples: [],
  ...over,
});

// --- the command table ---

test("there are exactly the commands this tool is for", () => {
  assert.deepEqual(Object.keys(COMMANDS), ["jobs", "wait", "clean"]);
  for (const [name, spec] of Object.entries(COMMANDS)) {
    assert.equal(typeof spec.run, "function", name);
    assert.match(spec.summary, /\S/, `${name} needs a summary`);
  }
});

test("only clean can delete anything, and only with --apply", () => {
  // The property that has to survive any future command: `clean` is the only
  // command that removes anything, and it does not unless asked.
  const writers = Object.entries(COMMANDS)
    .filter(([name]) => name === "clean")
    .map(([name]) => name);
  assert.deepEqual(writers, ["clean"]);

  for (const flag of ["apply", "prune"]) {
    assert.ok(COMMANDS.clean.accepts.includes(flag), `clean should take --${flag}`);
  }
});

test("every command can be reached by typing its name", () => {
  for (const name of Object.keys(COMMANDS)) {
    assert.equal(parseArgs([name]).command, name);
  }
});

test("every setting in the schema is read by the code, not just accepted", async () => {
  // A setting that is accepted and never used is the worst kind of config
  // bug: it looks like it is working. Enforced by reading the sources.
  const dir = new URL("../src/", import.meta.url);
  const sources = (
    await Promise.all(
      (await readdir(dir))
        .filter((f) => f.endsWith(".js"))
        .map(async (f) => {
          const text = await readFile(new URL(f, dir), "utf8");
          // The schema mentions every key by definition, so it has to be
          // removed before asking whether anything else does.
          return f === "config.js"
            ? text.replace(/export const SCHEMA = \[[\s\S]*?\n\];/, "")
            : text;
        }),
    )
  ).join("\n");

  const unused = SCHEMA.filter((entry) => !sources.includes(entry.key.split(".").pop()));
  assert.deepEqual(unused.map((e) => e.key), [], "settings nothing reads");
});

test("every option is reachable under the name its own spec declares", () => {
  for (const [flag, spec] of Object.entries(OPTIONS)) {
    const argv = ["jobs", `--${flag}`, ...(spec.type === "value" ? ["x"] : [])];
    const parsed = parseArgs(argv);
    assert.deepEqual(parsed.errors, [], flag);
    assert.equal(parsed.options[spec.name], spec.type === "value" ? "x" : true, flag);
  }
});

// --- clean ---

const NOW = Date.parse("2026-01-01T01:00:00Z");

/** A `_work` tree with the given checkout ages in hours. */
async function workTree(spec) {
  const root = await mkdtemp(join(tmpdir(), "rq-clean-"));
  for (const [rel, ageHours] of Object.entries(spec)) {
    const path = join(root, rel);
    await mkdir(path, { recursive: true });
    const when = new Date(NOW - ageHours * 3_600_000);
    await utimes(path, when, when);
  }
  return root;
}

/**
 * The filesystem operations `clean` uses.
 *
 * `scan` and `diskUsage` are left as the real functions, pointed at a temporary
 * tree, so the age arithmetic and the directory walk are actually exercised
 * rather than a fixture shaped to match the implementation. `remove` and
 * `pruneWorktrees` are stubbed, because those are the operations that must never
 * be pointed at anything real in a test.
 */
const cleanDeps = (extra = {}) => ({
  stats: async () => ({ totalBytes: 500e9, freeBytes: 400e9, freePercent: 80 }),
  ...extra,
});

test("clean deletes nothing without --apply", async () => {
  // The single most important property of this command.
  const root = await workTree({ "acme/api/main": 50 });
  const removed = [];
  const result = await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24 }),
    { now: NOW, env: {} },
    cleanDeps({ remove: async (_r, p) => (removed.push(p), { removed: true, path: p }) }),
  );

  assert.deepEqual(removed, [], "nothing may be deleted without --apply");
  assert.match(result.out, /Would remove 1 checkout/);
  assert.match(result.out, /acme\/api\/main/);
  assert.match(result.out, /Re-run with --apply/);
  assert.equal(result.code, EXIT.attention);
});

test("clean with --apply deletes only what is past the threshold", async () => {
  const root = await workTree({ "acme/api/main": 50, "acme/api/dev": 2, "acme/web/main": 1 });
  const removed = [];
  const result = await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24 }),
    { apply: true, now: NOW, env: {} },
    cleanDeps({ remove: async (_r, p) => (removed.push(p), { removed: true, path: p }) }),
  );

  assert.equal(removed.length, 1);
  assert.match(result.out, /Removed 1 checkout/);
  // The fresh checkouts are named as kept, so the ones left behind cannot be
  // mistaken for ones that were removed too.
  assert.match(result.out, /Kept 2/);
  assert.match(result.out, /acme\/api\/dev/);
});

test("clean reports nothing to do when everything is fresh", async () => {
  const root = await workTree({ "acme/api/main": 1 });
  const result = await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24 }),
    { now: NOW, env: {} },
    cleanDeps(),
  );
  assert.match(result.out, /Nothing to clean/);
});

test("clean needs a work directory and says where to set one", async () => {
  // Thrown, not returned: it is a "you have not told us something we need"
  // message, so it belongs with the other config errors and on stderr.
  const cfg = await config({ workDir: null });
  await assert.rejects(
    () => cmdClean(cfg, { env: {} }, cleanDeps()),
    /no work directory to clean/,
  );
});

test("clean uses the runner's own RUNNER_WORK when nothing is configured", async () => {
  // The runner exports this for every job, which is why `clean` needs no
  // configuration to run on the machine it is cleaning.
  const root = await workTree({ "acme/api/main": 50 });
  const result = await cmdClean(
    await config({ workDir: null }),
    { now: NOW, env: { RUNNER_WORK: root } },
    cleanDeps(),
  );
  assert.match(result.out, /Would remove 1 checkout/);
});

test("clean prunes git worktrees once per repository, not per stale ref", async () => {
  const root = await workTree({ "acme/api/main": 50, "acme/api/release": 60, "acme/web/main": 40 });
  const pruned = [];
  await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24 }),
    { apply: true, prune: true, now: NOW, env: {} },
    cleanDeps({ pruneTrees: async (p) => (pruned.push(p), { ok: true, output: "" }) }),
  );

  assert.equal(pruned.length, 2, "two repositories, not three refs");
  assert.ok(pruned.every((p) => !p.endsWith("/main") && !p.endsWith("/release")));
});

test("clean can be told not to prune at all", async () => {
  const root = await workTree({ "acme/api/main": 50 });
  const pruned = [];
  await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24 }),
    { apply: true, prune: false, now: NOW, env: {} },
    cleanDeps({ pruneTrees: async (p) => (pruned.push(p), { ok: true, output: "" }) }),
  );
  assert.deepEqual(pruned, []);
});

test("a failed removal is an error, not a quiet partial success", async () => {
  const root = await workTree({ "acme/api/main": 50 });
  const result = await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24 }),
    { apply: true, now: NOW, env: {} },
    cleanDeps({ remove: async (_r, p) => ({ removed: false, path: p, error: "EACCES" }) }),
  );
  assert.equal(result.code, EXIT.error);
  assert.match(result.out, /1 removal\(s\) failed/);
  assert.match(result.out, /EACCES/);
});

test("clean --json reports what it did as data", async () => {
  const root = await workTree({ "acme/api/main": 50 });
  const result = await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24 }),
    { apply: true, json: true, now: NOW, env: {} },
    cleanDeps(),
  );
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.applied, true);
  assert.equal(parsed.staleWorkDirs, 1);
  assert.equal(parsed.cleanedBy[0].repo, "acme/api");
  assert.equal(parsed.cleanedBy[0].ageHours, 50);
});

// --- jobs ---

test("jobs reports an empty queue and exits 0", async () => {
  const result = await cmdJobs(await config(), {}, { queueFor: async () => queue([]) });
  assert.equal(result.code, EXIT.ok);
  assert.match(result.out, /queue is empty/);
});

test("jobs exits 2 when something is stuck, and 0 when nothing is", async () => {
  const cfg = await config();
  const stuck = await cmdJobs(cfg, {}, { queueFor: async () => queue([job()]) });
  assert.equal(stuck.code, EXIT.attention, "a job over the threshold is actionable");

  const fresh = await cmdJobs(
    cfg,
    {},
    { queueFor: async () => queue([job({ waitS: 30 })]) },
  );
  assert.equal(fresh.code, EXIT.ok, "a job under the threshold is not yet a problem");
});

test("jobs names the cause and the worst job first", async () => {
  const result = await cmdJobs(await config(), {}, {
    queueFor: async () =>
      queue([
        job({ waitS: 60 }),
        job({ waitS: 7200, jobName: "slow", cause: "label_mismatch" }),
      ]),
  });

  assert.match(result.out, /slow/, "the longest wait leads");
  assert.match(result.out, /label_mismatch/);
  assert.match(result.out, /2h 00m/);
});

test("jobs counts repositories that have queued work, not repositories in scope", async () => {
  const result = await cmdJobs(await config(), {}, {
    queueFor: async () =>
      queue([job()], {
        repos: Array.from({ length: 40 }, (_, i) => ({
          org: "acme",
          name: `r${i}`,
          full_name: `acme/r${i}`,
        })),
      }),
  });
  assert.match(result.out, /1 job\(s\) queued across 1 repo\(s\)/);
});

test("jobs says what the table left out", async () => {
  // A count of 3 above a list of 2, unexplained, reads as a job going missing.
  const result = await cmdJobs(await config(), {}, {
    queueFor: async () => queue([job({ waitS: 3600 }), job({ waitS: 7200 }), job({ waitS: 30 })]),
  });
  assert.match(result.out, /3 job\(s\) queued/);
  assert.match(result.out, /1 job\(s\) also queued, all under the 10m threshold/);
});

test("jobs reports repositories it could not read", async () => {
  const result = await cmdJobs(await config(), {}, {
    queueFor: async () => queue([job()], { unreadableRepos: ["acme/secret"] }),
  });
  assert.match(result.out, /Not read: acme\/secret/);
  assert.match(result.out, /incomplete/);
});

test("jobs explains a missing admin:org scope rather than hiding it", async () => {
  const result = await cmdJobs(await config(), {}, {
    queueFor: async () =>
      queue([job({ cause: "unknown_capacity", detail: "Runner capacity is unknown." })], {
        runners: [],
        unknownOrgs: new Set(["acme"]),
        runnerErrors: [
          { org: "acme", message: "Runner capacity is hidden.", fix: "gh auth refresh -h github.com -s admin:org" },
        ],
      }),
  });
  assert.match(result.out, /gh auth refresh/);
});

test("jobs --json is parseable and carries the diagnosis", async () => {
  const result = await cmdJobs(await config(), { json: true }, {
    queueFor: async () => queue([job()]),
  });
  const parsed = JSON.parse(result.out);

  assert.deepEqual(parsed.orgs, ["acme"]);
  assert.equal(parsed.summary.queuedJobs, 1);
  assert.equal(parsed.summary.stuckJobs, 1);
  assert.equal(parsed.jobs[0].cause, "all_busy");
  assert.equal(parsed.capacity.total, 1);
  assert.deepEqual(parsed.unknownOrgs, []);
});

test("jobs --json never contains colour codes", async () => {
  const result = await cmdJobs(await config(), { json: true, colour: true }, {
    queueFor: async () => queue([job()]),
  });
  assert.doesNotMatch(result.out, /\x1b\[/);
});

// --- wait ---

test("wait reports percentiles with their sample size", async () => {
  const result = await cmdWait(await config(), {}, { historyFor: async () => history() });
  assert.equal(result.code, EXIT.ok);
  assert.match(result.out, /median wait\s+1m 0s/);
  assert.match(result.out, /p90 wait\s+15m 0s\s+\(n=3\)/);
  assert.match(result.out, /blocked CI\s+2 job-hours/);
  assert.match(result.out, /queue share\s+50%/);
});

test("wait says so when there is nothing to measure, rather than printing zeros", async () => {
  const result = await cmdWait(await config(), {}, {
    historyFor: async () =>
      history({ overall: { n: 0, p50: 0, p90: 0, max: 0, mean: 0 }, byRepo: [], workflows: [], daily: [] }),
  });
  assert.match(result.out, /No completed runs/);
  assert.doesNotMatch(result.out, /median wait/);
});

test("wait marks a cached sample so the numbers are not mistaken for fresh ones", async () => {
  const result = await cmdWait(await config(), {}, {
    historyFor: async () => history({ cached: true }),
  });
  assert.match(result.out, /\(cached\)/);
});

test("wait --json carries the raw samples for scripts", async () => {
  const result = await cmdWait(await config(), { json: true }, {
    historyFor: async () => history(),
  });
  const parsed = JSON.parse(result.out);
  assert.deepEqual(parsed.orgs, ["acme"]);
  assert.equal(parsed.overall.n, 3);
  assert.ok(Array.isArray(parsed.samples));
  assert.ok(Array.isArray(parsed.daily));
});
