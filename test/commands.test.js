import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, OPTIONS } from "../src/args.js";
import { COMMANDS, cmdClean, cmdJobs, cmdWait } from "../src/commands.js";
import { SCHEMA, loadConfig } from "../src/config.js";
import { EXIT } from "../src/errors.js";
import { hostIndex } from "../src/hosts.js";

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

// --- jobs: the host block ---

const NOW = Date.parse("2026-01-01T01:00:00Z");

/** A host index shaped the way `queueFor` builds it. */
const reported = (reports, thresholds = {}) =>
  hostIndex(reports, { minFreePercent: 5, maxAgeMinutes: 30, ...thresholds });

test("jobs shows which hosts reported, tight ones included", async () => {
  const result = await cmdJobs(await config(), { now: NOW }, {
    queueFor: async () =>
      queue([job({ cause: "host_disk_pressure", detail: "r1 is out of disk" })], {
        hosts: reported([
          { runner: "r1", at: new Date(NOW).toISOString(), disk: { freePercent: 1 } },
          { runner: "r2", at: new Date(NOW).toISOString(), disk: { freePercent: 80 } },
        ]),
      }),
  });

  assert.match(result.out, /Hosts/);
  assert.match(result.out, /r1\s+1% free\s+under 5%/);
  assert.match(result.out, /r2\s+80% free/);
});

test("a configured report directory with nothing in it says so", async () => {
  // Silence must not read as health. With reports configured and none present,
  // the tool has to admit it is not checking disk at all.
  const result = await cmdJobs(await config(), { now: NOW }, {
    queueFor: async () => queue([job()], { hosts: reported([]) }),
  });
  assert.match(result.out, /no reports in the host report directory/);
  assert.match(result.out, /not being checked against disk/);
});

test("an unreadable host report is named as a gap", async () => {
  const result = await cmdJobs(await config(), { now: NOW }, {
    queueFor: async () =>
      queue([job()], {
        hosts: reported([
          { runner: "r1", at: new Date(NOW).toISOString(), disk: { freePercent: 90 } },
        ]),
        hostErrors: [{ file: "r2.json", message: "not a JSON object" }],
      }),
  });
  assert.match(result.out, /Host reports not read: r2\.json/);
  assert.match(result.out, /disk pressure is not being checked/);
});

test("a stale host report is shown but marked as not trusted", async () => {
  const result = await cmdJobs(await config({ hostReportMaxAgeMinutes: 30 }), { now: NOW }, {
    queueFor: async () =>
      queue([job()], {
        hosts: reported([
          { runner: "r1", at: new Date(NOW - 3_600_000).toISOString(), disk: { freePercent: 1 } },
        ]),
      }),
  });
  assert.match(result.out, /r1\s+1% free\s+\(report too old to trust\)/);
});

test("a host with no disk figures says so rather than showing a bare number", async () => {
  const result = await cmdJobs(await config(), { now: NOW }, {
    queueFor: async () =>
      queue([job()], {
        hosts: reported([{ runner: "r1", at: new Date(NOW).toISOString(), disk: null }]),
      }),
  });
  assert.match(result.out, /r1\s+disk unknown/);
});

test("jobs without host reports is unchanged", async () => {
  const before = await cmdJobs(await config(), {}, { queueFor: async () => queue([job()]) });
  assert.doesNotMatch(before.out, /Hosts/);
  assert.doesNotMatch(before.out, /Host reports not read/);
});

test("jobs --json always carries the hosts key, reports or not", async () => {
  const without = JSON.parse(
    (await cmdJobs(await config(), { json: true }, { queueFor: async () => queue([job()]) })).out,
  );
  assert.equal(without.hosts, null);

  const withHosts = JSON.parse(
    (await cmdJobs(await config(), { json: true, now: NOW }, {
      queueFor: async () =>
        queue([job()], {
          hosts: reported([
            { runner: "r1", at: new Date(NOW).toISOString(), disk: { freePercent: 1 } },
          ]),
        }),
    })).out,
  );
  assert.equal(withHosts.hosts.reports.length, 1);
  assert.equal(withHosts.hosts.minFreePercent, 5);
});

// --- clean ---

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

test("clean writes a host report naming the runner, for jobs to read back", async () => {
  const root = await workTree({ "acme/api/main": 50 });
  const saved = [];
  const result = await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24, hostReportDir: "/reports" }),
    { apply: true, report: true, runner: "runner-07", hostname: "build07", now: NOW, env: {} },
    cleanDeps({
      save: async (dir, name, rep) => {
        saved.push({ dir, name, rep });
        return "/reports/runner-07.json";
      },
    }),
  );

  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, "runner-07");
  assert.equal(saved[0].rep.runner, "runner-07");
  assert.equal(saved[0].rep.staleWorkDirs, 1);
  assert.equal(saved[0].rep.removedWorkDirs, 1);
  assert.equal(saved[0].rep.disk.freePercent, 80);
  // `at` is what makes staleness detectable on the reading side.
  assert.equal(saved[0].rep.at, new Date(NOW).toISOString());
  assert.match(result.out, /Host report written to/);
});

test("the host report carries counts, not a list of directories that may be gone", async () => {
  // The report is written after the removals, so an inventory taken before them
  // would describe directories that no longer exist -- and `jobs` reads this to
  // judge whether a disk is full.
  const root = await workTree({ "acme/api/main": 50, "acme/api/dev": 2 });
  let written = null;
  await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24, hostReportDir: "/reports" }),
    { apply: true, report: true, now: NOW, env: {} },
    cleanDeps({ save: async (_d, _n, rep) => ((written = rep), "/reports/x.json") }),
  );

  assert.equal(written.cleanedBy, undefined);
  assert.equal(written.workDirCount, 2);
  assert.equal(written.staleWorkDirs, 1);
});

test("a dry run still reports, because a nearly-full host is true either way", async () => {
  const root = await workTree({ "acme/api/main": 50 });
  const saved = [];
  await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24, hostReportDir: "/reports" }),
    { report: true, now: NOW, env: {} },
    cleanDeps({ save: async (_d, _n, rep) => (saved.push(rep), "/reports/x.json") }),
  );

  assert.equal(saved.length, 1);
  assert.equal(saved[0].staleWorkDirs, 1, "the report says there is something to clean");
  assert.equal(saved[0].removedWorkDirs, 0, "and that nothing was removed");
});

test("no report is written without --report", async () => {
  const root = await workTree({ "acme/api/main": 50 });
  const saved = [];
  const result = await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24, hostReportDir: "/reports" }),
    { apply: true, now: NOW, env: {} },
    cleanDeps({ save: async () => (saved.push(1), "/reports/x.json") }),
  );

  assert.deepEqual(saved, []);
  assert.doesNotMatch(result.out, /Host report written/);
});

test("asking for a report with no directory set says so rather than doing nothing", async () => {
  const root = await workTree({ "acme/api/main": 50 });
  const result = await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24, hostReportDir: null }),
    { apply: true, report: true, now: NOW, env: {} },
    cleanDeps({ save: async () => null }),
  );
  assert.match(result.out, /no host report directory is set/);
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

test("the file written is named after the runner and says so inside", async () => {
  // The real writer, not a stub: the name on disk and the `runner` field inside
  // it have to agree, or `jobs` cannot match the report to anything.
  const root = await workTree({ "acme/api/main": 50 });
  const dir = await mkdtemp(join(tmpdir(), "rq-reports-"));
  await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24, hostReportDir: dir }),
    { report: true, runner: "runner-07", hostname: "build07", now: NOW, env: {} },
    cleanDeps(),
  );

  const written = JSON.parse(await readFile(join(dir, "runner-07.json"), "utf8"));
  assert.equal(written.runner, "runner-07");
  assert.equal(written.hostname, "build07");
  assert.equal(typeof written.disk.freePercent, "number");
});

test("a host with no runner name falls back to the hostname", async () => {
  // Run by hand rather than from a job, there is no RUNNER_NAME. The report is
  // still attributable, which is the only thing that makes it matchable.
  const root = await workTree({ "acme/api/main": 50 });
  const dir = await mkdtemp(join(tmpdir(), "rq-reports-"));
  await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24, hostReportDir: dir }),
    { report: true, runner: null, hostname: "build07", now: NOW, env: {} },
    cleanDeps(),
  );

  const written = JSON.parse(await readFile(join(dir, "build07.json"), "utf8"));
  assert.equal(written.runner, "build07");
});

test("the report directory is created if it is not there yet", async () => {
  // The point is that `clean --report` can run from a job with no prior setup.
  const root = await workTree({ "acme/api/main": 50 });
  const base = await mkdtemp(join(tmpdir(), "rq-reports-"));
  const dir = join(base, "not", "there", "yet");
  await cmdClean(
    await config({ workDir: root, cleanupAgeHours: 24, hostReportDir: dir }),
    { report: true, runner: "runner-07", hostname: "build07", now: NOW, env: {} },
    cleanDeps(),
  );
  assert.ok((await readFile(join(dir, "runner-07.json"), "utf8")).length > 0);
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
