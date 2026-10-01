import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diskPressure,
  diskUsage,
  freePercentFor,
  hostIndex,
  hostReportFor,
  isFresh,
  pressureFor,
  readHostReports,
  removeCheckout,
  scanWorkDir,
  staleCheckouts,
} from "../src/hosts.js";

/**
 * The destructive half of the tool, against made-up directories rather than a
 * real runner. These tests exercise the actual deletion path rather than a
 * stubbed one, because the deletion path is the thing worth being sure of.
 */

const tmp = () => mkdtemp(join(tmpdir(), "rq-hosts-"));

const hoursAgo = (h, now) => now - h * 3_600_000;

const report = (over = {}) => ({
  runner: "runner-01",
  at: new Date().toISOString(),
  disk: { totalBytes: 500e9, freeBytes: 250e9, freePercent: 50 },
  ...over,
});

// --- reading reports ------------------------------------------------------

test("a report is read from the directory and named after its file", async () => {
  const dir = await tmp();
  // No `runner` field: the file name is the identity, which is how a host that
  // only knows its own hostname still produces something `jobs` can use.
  await writeFile(
    join(dir, "runner-03.json"),
    JSON.stringify({ at: new Date().toISOString() }),
  );

  const { reports, errors } = await readHostReports(dir);
  assert.equal(errors.length, 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].runner, "runner-03");
});

test("a missing report directory is a gap, not a failure", async () => {
  const { reports, errors } = await readHostReports("/nonexistent/host-reports");
  assert.deepEqual(reports, []);
  assert.equal(errors.length, 1);
  // The wording matters: this has to read as "we could not check", not "all clear".
  assert.match(errors[0].message, /could not read host report directory/);
});

test("an unparseable report is reported and the others still load", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "runner-01.json"), JSON.stringify(report()));
  await writeFile(join(dir, "runner-02.json"), "{ not json");

  const { reports, errors } = await readHostReports(dir);
  assert.deepEqual(reports.map((r) => r.runner), ["runner-01"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, "runner-02.json");
});

test("no directory configured means no reports and no error", async () => {
  const { reports, errors } = await readHostReports(null);
  assert.deepEqual(reports, []);
  assert.deepEqual(errors, []);
});

// --- pressure -------------------------------------------------------------

test("a host under the free-space threshold counts as tight", () => {
  const hosts = hostIndex([report({ disk: { freePercent: 2 } })], { minFreePercent: 5 });
  assert.equal(pressureFor({ name: "runner-01" }, hosts), true);
});

test("a host with room counts as not tight", () => {
  const hosts = hostIndex([report({ disk: { freePercent: 40 } })], { minFreePercent: 5 });
  assert.equal(pressureFor({ name: "runner-01" }, hosts), false);
});

test("a runner nobody reported on is unknown, not healthy", () => {
  // The distinction the whole design turns on: `null` is not `false`.
  const hosts = hostIndex([report()], { minFreePercent: 5 });
  assert.equal(pressureFor({ name: "runner-99" }, hosts), null);
});

test("a stale report is ignored rather than trusted", () => {
  const now = Date.now();
  const stale = report({
    at: new Date(hoursAgo(2, now)).toISOString(),
    disk: { freePercent: 1 },
  });
  const hosts = hostIndex([stale], { minFreePercent: 5, maxAgeMinutes: 30 });
  assert.equal(pressureFor({ name: "runner-01" }, hosts, { now }), null);
});

test("a report from the future is ignored", () => {
  const now = Date.now();
  const ahead = report({
    at: new Date(now + 60 * 60_000).toISOString(),
    disk: { freePercent: 1 },
  });
  assert.equal(isFresh(ahead, 30, now), false);
});

test("a report with no figures makes no claim", () => {
  assert.equal(diskPressure({ disk: {} }, 5), false);
  assert.equal(diskPressure({}, 5), false);
  assert.equal(freePercentFor({ name: "runner-01" }, hostIndex([report({ disk: null })])), null);
});

test("reports are looked up by runner name", () => {
  const hosts = hostIndex([report(), report({ runner: "runner-02" })]);
  assert.equal(hostReportFor(hosts, "runner-02").runner, "runner-02");
  assert.equal(hostReportFor(hosts, "runner-99"), null);
});

/** Builds a `_work` tree with the given `<owner>/<repo>/<ref>` checkouts. */
async function workTree(spec) {
  const root = await tmp();
  const now = Date.now();
  for (const [rel, ageHours] of Object.entries(spec)) {
    const path = join(root, rel);
    await mkdir(path, { recursive: true });
    const when = new Date(hoursAgo(ageHours, now));
    await writeFile(join(path, ".marker"), "");
    await utimes(path, when, when);
  }
  return { root, now };
}

// --- disk -----------------------------------------------------------------

test("diskUsage reports free space as a percentage of the total", async () => {
  const { root } = await workTree({ "acme/api/main": 1 });
  const disk = await diskUsage(root);
  assert.ok(disk.totalBytes > 0);
  assert.ok(disk.freePercent >= 0 && disk.freePercent <= 100);
});

test("diskUsage on a path that is not there is null, not a throw", async () => {
  // A host that cannot report its disk should still be cleanable.
  assert.equal(await diskUsage("/nonexistent/_work"), null);
});

// --- scanning -------------------------------------------------------------

test("checkouts are found two levels down and aged", async () => {
  const { root, now } = await workTree({
    "acme/api/main": 50,
    "acme/web/main": 2,
  });

  const found = await scanWorkDir({ root, now });
  assert.deepEqual(found.checkouts.map((c) => c.rel).sort(), ["acme/api/main", "acme/web/main"]);

  const api = found.checkouts.find((c) => c.repo === "acme/api");
  assert.equal(api.ref, "main");
  assert.equal(api.ageHours, 50);
  // `git worktree prune` has to run at the repository root, not in the ref
  // directory, because that is where the admin files live.
  assert.equal(api.repoPath, join(found.root, "acme", "api"));
});

test("the runner's own directories are never candidates", async () => {
  const { root, now } = await workTree({ "acme/api/main": 500 });
  // `_temp` can hold a job mid-transfer; deleting it corrupts a run rather than
  // tidying one, so it is excluded however old it is.
  await mkdir(join(root, "_temp", "payload"), { recursive: true });

  const found = await scanWorkDir({ root, now });
  const rels = found.checkouts.map((c) => c.rel);
  assert.ok(!rels.some((r) => r.startsWith("_temp")), rels.join(", "));
});

test("a work directory that does not exist says so", async () => {
  await assert.rejects(() => scanWorkDir({ root: "/nonexistent/_work" }), /no such work directory/);
});

// --- the age threshold ----------------------------------------------------

test("only checkouts past the threshold are stale", () => {
  const checkouts = [
    { rel: "a", ageHours: 30 },
    { rel: "b", ageHours: 23 },
    { rel: "c", ageHours: 25 },
  ];
  const { stale, kept } = staleCheckouts(checkouts, 24);
  assert.deepEqual(stale.map((c) => c.rel), ["a", "c"]);
  assert.deepEqual(kept.map((c) => c.rel), ["b"]);
});

test("the threshold is inclusive, so a checkout exactly at it goes", () => {
  const { stale } = staleCheckouts([{ rel: "a", ageHours: 24 }], 24);
  assert.equal(stale.length, 1);
});

test("age is floored, so nothing goes before the threshold it prints", async () => {
  // Regression: `Math.ceil` reported a 23h 59m directory as 24h, which meant
  // `--cleanup-age-hours 24` deleted things a minute before it said it would.
  const root = await tmp();
  const path = join(root, "acme", "api", "main");
  await mkdir(path, { recursive: true });

  const now = Date.now();
  const justUnder = new Date(now - 24 * 3_600_000 + 60_000);
  await utimes(path, justUnder, justUnder);

  const found = await scanWorkDir({ root, now });
  const { stale, kept } = staleCheckouts(found.checkouts, 24);
  assert.equal(found.checkouts[0].ageHours, 23, "reads as 23h, not 24h");
  assert.deepEqual(kept.map((c) => c.rel), ["acme/api/main"]);
  assert.deepEqual(stale, []);
});

// --- deletion -------------------------------------------------------------

test("a stale checkout is really removed", async () => {
  const { root, now } = await workTree({ "acme/api/main": 50, "acme/api/dev": 1 });
  const found = await scanWorkDir({ root, now });
  const stale = staleCheckouts(found.checkouts, 24).stale;
  assert.equal(stale.length, 1);

  const result = await removeCheckout(found.root, stale[0].path);
  assert.equal(result.removed, true);

  const after = await scanWorkDir({ root, now });
  assert.deepEqual(after.checkouts.map((c) => c.rel), ["acme/api/dev"]);
});

test("a symlink out of _work is refused rather than followed", async () => {
  const { root, now } = await workTree({ "acme/api/main": 50 });
  const outside = await tmp();
  const precious = join(outside, "precious");
  await writeFile(precious, "do not delete");

  // A symlink pointing outside the work directory. `git worktree` makes these
  // inside a real `_work`, so this is the shape that actually occurs.
  const found = await scanWorkDir({ root, now });
  await symlink(outside, join(found.root, "acme", "api", "escape"));

  const escape = join(found.root, "acme", "api", "escape");
  const result = await removeCheckout(found.root, escape);
  assert.equal(result.removed, false);
  assert.match(result.error, /outside the work directory/);

  // The thing on the other end of the symlink survived.
  assert.equal(await readFile(precious, "utf8"), "do not delete");
});

test("the work directory itself can never be removed", async () => {
  const { root, now } = await workTree({ "acme/api/main": 50 });
  const found = await scanWorkDir({ root, now });
  const result = await removeCheckout(found.root, found.root);
  assert.equal(result.removed, false);
});

test("a path that has already gone is not an error worth reporting", async () => {
  const { root } = await workTree({ "acme/api/main": 50 });
  const result = await removeCheckout(root, join(root, "acme", "api", "gone"));
  assert.equal(result.removed, false);
  assert.ok(result.error, "but the reason is still returned");
});
