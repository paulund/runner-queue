import test from "node:test";
import assert from "node:assert/strict";
import { mapLimit, summarise, visibleRepos, waitingJobs } from "../src/github.js";

const job = (over = {}) => ({
  repo: "acme/api",
  org: "acme",
  runId: 1,
  runName: "Test",
  event: "push",
  conclusion: "success",
  runCreatedAt: "2026-01-01T00:00:00Z",
  runUpdatedAt: "2026-01-01T00:10:00Z",
  jobCreatedAt: "2026-01-01T00:00:00Z",
  jobName: "unit",
  labels: ["self-hosted", "linux"],
  waitS: 60,
  at: "2026-01-01T00:00:00Z",
  ...over,
});

test("summarise computes percentiles over job wait times", () => {
  const jobs = Array.from({ length: 100 }, (_, i) =>
    job({
      waitS: i + 1,
      at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    }),
  );
  const out = summarise(jobs);
  assert.equal(out.overall.n, 100);
  assert.equal(out.overall.max, 100);
  assert.ok(out.overall.p50 >= 49 && out.overall.p50 <= 51);
});

test("summarise keeps workflow names that contain spaces intact", () => {
  // Regression: the aggregation key used to be a space-delimited string, so
  // "Cloudflare incidents" was split into repo="...Cloudflare".
  const jobs = [
    job({ runName: "Cloudflare incidents", waitS: 10 }),
    job({ runName: "Cloudflare incidents", waitS: 20 }),
    job({ runName: "Test", waitS: 30 }),
  ];
  const out = summarise(jobs);
  const names = out.workflows.map((w) => w.workflow);
  assert.ok(names.includes("Cloudflare incidents"));
  assert.equal(out.workflows.find((w) => w.workflow === "Cloudflare incidents").n, 2);
});

test("summarise reports empty input without throwing", () => {
  const out = summarise([]);
  assert.equal(out.overall.n, 0);
  assert.equal(out.workflows.length, 0);
  assert.deepEqual(out.daily, []);
});

test("timeToGreen measures run duration and attributes the wait share", () => {
  const out = summarise([
    job({
      runId: 1,
      waitS: 300,
      runCreatedAt: "2026-01-01T00:00:00Z",
      runUpdatedAt: "2026-01-01T00:10:00Z",
    }),
    job({
      runId: 2,
      waitS: 100,
      runCreatedAt: "2026-01-01T01:00:00Z",
      runUpdatedAt: "2026-01-01T01:10:00Z",
    }),
  ]);
  assert.equal(out.timeToGreen.n, 2);
  assert.equal(out.timeToGreen.p50, 600);
  // 400s waiting inside 1200s of total run time.
  assert.ok(Math.abs(out.timeToGreen.waitShare - 400 / 1200) < 1e-9);
});

test("timeToGreen reports the shortest job wait as the run's queue delay", () => {
  // A run is delayed by how long its first job waited, not by an arbitrary
  // job's wait; parallel jobs would otherwise inflate the run's share.
  const out = summarise([
    job({
      runId: 7,
      waitS: 500,
      runCreatedAt: "2026-01-01T00:00:00Z",
      runUpdatedAt: "2026-01-01T00:20:00Z",
    }),
    job({
      runId: 7,
      waitS: 60,
      runCreatedAt: "2026-01-01T00:00:00Z",
      runUpdatedAt: "2026-01-01T00:20:00Z",
    }),
  ]);
  assert.equal(out.timeToGreen.n, 1);
  const sample = out.timeToGreen.samples[0];
  // 1200s total minus the 60s it waited is the time it was actually running.
  assert.equal(sample.durationS, 1140);
});

test("blockedHours sums queued seconds per day", () => {
  const out = summarise([
    job({ waitS: 3600, at: "2026-01-01T00:00:00Z" }),
    job({ waitS: 1800, at: "2026-01-01T05:00:00Z" }),
    job({ waitS: 1800, at: "2026-01-02T05:00:00Z" }),
  ]);
  assert.equal(out.blockedHours.series.length, 2);
  assert.equal(out.blockedHours.totalHours, 2);
});

test("samples keep the org they came from, so figures can be split per org", () => {
  const out = summarise([
    job({ repo: "acme/api", org: "acme", waitS: 10 }),
    job({ repo: "other/api", org: "other", waitS: 20 }),
  ]);
  assert.deepEqual(
    out.samples.map((s) => s.org).sort(),
    ["acme", "other"],
  );
});

test("archived repositories are excluded unless asked for", () => {
  // Their workflows never run, so they only add noise and API calls.
  const repos = [
    { name: "live", archived: false },
    { name: "dead", archived: true },
  ];
  assert.deepEqual(visibleRepos(repos).map((r) => r.name), ["live"]);
  assert.deepEqual(
    visibleRepos(repos, { includeArchived: true }).map((r) => r.name),
    ["live", "dead"],
  );
});

test("only jobs that are still waiting are treated as queued", () => {
  // Regression: a run is left marked `queued` by GitHub while its jobs are
  // already running, and until the last one finishes. Taking the run at its
  // word reported a job that had been running for an hour, and one that had
  // finished, as "queued" -- with the wait measured to *now* rather than to
  // the moment a runner picked the job up.
  const jobs = [
    { name: "test-unit", status: "completed", started_at: "t1", completed_at: "t2" },
    { name: "build", status: "in_progress", started_at: "t3", completed_at: null },
    { name: "test-integration", status: "queued", started_at: null, completed_at: null },
  ];

  assert.deepEqual(waitingJobs(jobs).map((j) => j.name), ["test-integration"]);
  assert.deepEqual(waitingJobs([]), []);
  assert.deepEqual(waitingJobs(undefined), []);
});

test("mapLimit keeps results in order and honours the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return n * 2;
  });

  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `ran ${peak} at once, expected at most 3`);
});

test("mapLimit copes with an empty list", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
