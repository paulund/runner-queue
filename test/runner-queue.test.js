import test from "node:test";
import assert from "node:assert/strict";
import { summarise } from "../src/github.js";
import {
  diagnoseJob,
  matchesLabels,
  buildQueue,
  capacitySummary,
} from "../src/diagnose.js";
import { findSuperseded, recommendFleet, shouldAlert } from "../src/insights.js";
import { lintWorkflow } from "../src/lint.js";
import { loadConfig, filterRepos } from "../src/config.js";

const job = (over = {}) => ({
  repo: "acme/api",
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

const runner = (over = {}) => ({
  id: 1,
  name: "r1",
  os: "linux",
  status: "online",
  busy: false,
  labels: ["self-hosted", "linux"],
  ephemeral: false,
  ...over,
});

test("summarise computes percentiles over job wait times", () => {
  const jobs = Array.from({ length: 100 }, (_, i) =>
    job({ waitS: i + 1, at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` }),
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
    job({ runId: 1, waitS: 300, runCreatedAt: "2026-01-01T00:00:00Z", runUpdatedAt: "2026-01-01T00:10:00Z" }),
    job({ runId: 2, waitS: 100, runCreatedAt: "2026-01-01T01:00:00Z", runUpdatedAt: "2026-01-01T01:10:00Z" }),
  ]);
  assert.equal(out.timeToGreen.n, 2);
  assert.equal(out.timeToGreen.p50, 600);
  // 400s waiting inside 1200s of total run time.
  assert.ok(Math.abs(out.timeToGreen.waitShare - 400 / 1200) < 1e-9);
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

test("matchesLabels treats self-hosted as implied and ANDs the rest", () => {
  const r = runner({ labels: ["self-hosted", "linux", "x64"] });
  assert.equal(matchesLabels(r, ["self-hosted"]), true);
  assert.equal(matchesLabels(r, ["self-hosted", "linux"]), true);
  assert.equal(matchesLabels(r, ["self-hosted", "macos"]), false);
  assert.equal(matchesLabels(r, ["self-hosted", "linux", "x64"]), true);
  assert.equal(matchesLabels(r, []), true);
});

test("diagnoseJob reports scheduling when an idle eligible runner exists", () => {
  const now = Date.parse("2026-01-01T00:20:00Z");
  const d = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
    [runner()],
    { now },
  );
  assert.equal(d.cause, "scheduling");
  assert.equal(d.waitS, 1200);
  assert.match(d.detail, /r1/);
});

test("diagnoseJob reports all_busy when every eligible runner is working", () => {
  const d = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
    [runner({ busy: true }), runner({ id: 2, name: "r2", busy: true })],
    { now: Date.parse("2026-01-01T00:20:00Z") },
  );
  assert.equal(d.cause, "all_busy");
  assert.match(d.detail, /r1, r2/);
});

test("diagnoseJob separates label_mismatch from no_runners_online", () => {
  const mismatch = diagnoseJob(
    { labels: ["self-hosted", "macos"], created_at: "2026-01-01T00:00:00Z" },
    [runner()],
    { now: Date.parse("2026-01-01T00:20:00Z") },
  );
  assert.equal(mismatch.cause, "label_mismatch");
  assert.match(mismatch.detail, /macos/);

  const offline = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
    [runner({ status: "offline" })],
    { now: Date.parse("2026-01-01T00:20:00Z") },
  );
  assert.equal(offline.cause, "no_runners_online");
});

test("diagnoseJob never guesses a cause when runner state is unknown", () => {
  const d = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
    null,
    { now: Date.parse("2026-01-01T00:20:00Z") },
  );
  assert.equal(d.cause, "unknown_capacity");
});

test("jobs over the threshold escalate to signal severity", () => {
  const now = Date.parse("2026-01-01T02:00:00Z");
  const over = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
    null,
    { now, thresholdS: 600 },
  );
  assert.equal(over.severity, "signal");
  const under = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T01:55:00Z" },
    null,
    { now, thresholdS: 600 },
  );
  assert.equal(under.severity, "muted");
});

test("buildQueue sorts by longest wait first", () => {
  const perRepo = [
    {
      repo: "acme/api",
      queued: [
        {
          run: { id: 1, name: "Test", run_number: 1, event: "push", head_branch: "main", html_url: "u1" },
          jobs: [
            { id: 11, name: "quick", labels: ["self-hosted"], created_at: "2026-01-01T01:58:00Z" },
            { id: 12, name: "slow", labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
          ],
        },
      ],
      inProgress: [],
    },
  ];
  const out = buildQueue(perRepo, null, { now: Date.parse("2026-01-01T02:00:00Z") });
  assert.equal(out.length, 2);
  assert.equal(out[0].jobName, "slow");
  assert.equal(out[0].waitS, 7200);
});

test("capacitySummary counts idle, busy and offline runners", () => {
  const out = capacitySummary([
    runner(),
    runner({ id: 2, name: "r2", busy: true }),
    runner({ id: 3, name: "r3", status: "offline", busy: false }),
  ]);
  assert.equal(out.total, 3);
  assert.equal(out.online, 2);
  assert.equal(out.busy, 1);
  assert.equal(out.idle, 1);
  assert.equal(out.offline, 1);
  assert.equal(capacitySummary(null), null);
});

// --- superseded run detection ---

const qjob = (over = {}) => ({
  repo: "acme/api",
  runId: 1,
  runNumber: 1,
  runName: "Test",
  event: "push",
  branch: "main",
  headSha: "abc123",
  url: "u",
  createdAt: "2026-01-01T00:00:00Z",
  waitS: 60,
  cause: "all_busy",
  ...over,
});

test("a retried run on the same commit is superseded by the newer attempt", () => {
  // Same branch and same commit, queued twice (a rerun, or a push event plus
  // a workflow_dispatch). The newer attempt makes the older one pointless.
  const out = findSuperseded([
    qjob({ runId: 1, headSha: "aaa", createdAt: "2026-01-01T00:00:00Z" }),
    qjob({ runId: 2, headSha: "aaa", createdAt: "2026-01-01T01:00:00Z" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].runId, 1);
  assert.equal(out[0].supersededBy.runId, 2);
});

test("two different commits on one branch are not supersessions", () => {
  // A newer commit is new work, not a duplicate, so neither run is redundant.
  const out = findSuperseded([
    qjob({ runId: 1, headSha: "aaa", createdAt: "2026-01-01T00:00:00Z" }),
    qjob({ runId: 2, headSha: "bbb", createdAt: "2026-01-01T01:00:00Z" }),
  ]);
  assert.equal(out.length, 0);
});

test("dependabot dynamic runs are never treated as superseding each other", () => {
  // Regression: dependabot `dynamic` runs all report head_branch=main, so a
  // branch-only comparison marked three unrelated dependency bumps as
  // superseding one another -- and cancelling one would discard real work.
  const out = findSuperseded([
    qjob({ runId: 119, event: "dynamic", branch: "main", headSha: "s1", createdAt: "2026-01-01T00:00:00Z" }),
    qjob({ runId: 120, event: "dynamic", branch: "main", headSha: "s2", createdAt: "2026-01-01T01:00:00Z" }),
    qjob({ runId: 121, event: "dynamic", branch: "main", headSha: "s3", createdAt: "2026-01-01T02:00:00Z" }),
  ]);
  assert.equal(out.length, 0);
});

test("manual dispatches are not treated as superseded", () => {
  const out = findSuperseded([
    qjob({ runId: 1, event: "workflow_dispatch", branch: "main", headSha: "a" }),
    qjob({ runId: 2, event: "workflow_dispatch", branch: "main", headSha: "b", createdAt: "2026-01-01T02:00:00Z" }),
  ]);
  assert.equal(out.length, 0);
});

test("runs on different branches never supersede each other", () => {
  const out = findSuperseded([
    qjob({ runId: 1, branch: "feature-a", headSha: "a" }),
    qjob({ runId: 2, branch: "feature-b", headSha: "a", createdAt: "2026-01-01T05:00:00Z" }),
  ]);
  assert.equal(out.length, 0);
});

// --- fleet sizing ---

const hist = (over = {}) => ({
  overall: { n: 200, mean: 600, p50: 60, p90: 1200, max: 3000 },
  daily: [{ day: "2026-01-01", n: 200 }],
  blockedHours: { totalHours: 24, days: 1, series: [] },
  ...over,
});

test("recommendFleet adds runners only when demand exceeds supply", () => {
  const saturated = recommendFleet({
    history: hist({ overall: { n: 2000, mean: 3600 } }),
    capacity: { total: 1, idle: 0 },
  });
  assert.equal(saturated.verdict, "saturated");
  assert.ok(saturated.add >= 1);

  const healthy = recommendFleet({
    history: hist(),
    capacity: { total: 20, idle: 18 },
  });
  assert.equal(healthy.verdict, "healthy");
  assert.equal(healthy.add, 0);
});

test("recommendFleet blames labels rather than fleet size when runners sit idle", () => {
  const out = recommendFleet({
    history: hist({ overall: { n: 2000, mean: 3600 } }),
    capacity: { total: 4, idle: 4 },
  });
  assert.match(out.reason, /labels/);
});

test("recommendFleet refuses to guess without runner state or history", () => {
  assert.equal(
    recommendFleet({ history: hist(), capacity: null }).reason,
    "no_runner_state",
  );
  assert.equal(
    recommendFleet({ history: { daily: [], overall: { n: 0 } }, capacity: { total: 2 } }).reason,
    "not_enough_history",
  );
});

// --- alerting ---

test("shouldAlert stays quiet for a momentary spike", () => {
  // Over the 10-minute threshold but under the 15-minute sustain window.
  const out = shouldAlert({
    jobs: [{ waitS: 700, cause: "all_busy" }],
    thresholdS: 600,
    sustainedMinutes: 15,
    state: {},
  });
  assert.equal(out.fire, false);
  assert.equal(out.reason, "not_sustained");
});

test("shouldAlert stays quiet below the threshold entirely", () => {
  const out = shouldAlert({
    jobs: [{ waitS: 120, cause: "all_busy" }],
    thresholdS: 600,
    sustainedMinutes: 15,
    state: {},
  });
  assert.equal(out.fire, false);
  assert.equal(out.reason, "under_threshold");
});

test("shouldAlert fires once the problem is sustained, then respects cooldown", () => {
  const jobs = [{ waitS: 3600, cause: "all_busy" }, { waitS: 1200, cause: "all_busy" }];
  const first = shouldAlert({
    jobs,
    thresholdS: 600,
    sustainedMinutes: 15,
    state: {},
  });
  assert.equal(first.fire, true);
  assert.equal(first.stuckJobs, 2);

  const duringCooldown = shouldAlert({
    jobs,
    thresholdS: 600,
    sustainedMinutes: 15,
    state: { lastFiredAt: Date.now() - 60_000, cooldownMinutes: 60 },
  });
  assert.equal(duringCooldown.reason, "cooldown");
});

test("shouldAlert stays quiet when the queue drains", () => {
  assert.equal(shouldAlert({ jobs: [], thresholdS: 600, state: {} }).reason, "queue_empty");
});

// --- linting ---

const wf = (body) => `name: ci\non: push\n${body}`;

test("lint flags runs-on labels that match no runner", () => {
  const out = lintWorkflow({
    path: "acme/api:.github/workflows/ci.yml",
    content: wf("jobs:\n  build:\n    runs-on: [self-hosted, macos]\n    steps:\n      - run: make\n"),
    runners: [{ name: "r1", status: "online", busy: false, labels: ["self-hosted", "linux"] }],
    hasRunnerState: true,
  });
  const finding = out.find((f) => f.rule === "unmatched-labels");
  assert.ok(finding);
  assert.equal(finding.level, "error");
});

test("lint flags offline-only runners", () => {
  const out = lintWorkflow({
    path: "acme/api:.github/workflows/ci.yml",
    content: wf("jobs:\n  build:\n    runs-on: [self-hosted]\n    steps:\n      - run: make\n"),
    runners: [{ name: "r1", status: "offline", busy: false, labels: ["self-hosted"] }],
    hasRunnerState: true,
  });
  assert.ok(out.find((f) => f.rule === "all-offline"));
});

test("lint flags mixing self-hosted with GitHub-hosted labels", () => {
  const out = lintWorkflow({
    path: "acme/api:.github/workflows/ci.yml",
    content: wf("jobs:\n  build:\n    runs-on: [self-hosted, ubuntu-latest]\n    steps:\n      - run: make\n"),
    runners: [],
    hasRunnerState: false,
  });
  assert.ok(out.find((f) => f.rule === "mixed-hosted"));
});

test("lint does not assert a cause when runner state is unavailable", () => {
  const out = lintWorkflow({
    path: "acme/api:.github/workflows/ci.yml",
    content: wf("jobs:\n  build:\n    runs-on: [self-hosted, macos]\n    steps:\n      - run: make\n"),
    runners: null,
    hasRunnerState: false,
  });
  assert.equal(out.find((f) => f.rule === "unmatched-labels"), undefined);
});

test("lint ignores commented-out configuration", () => {
  const out = lintWorkflow({
    path: "acme/api:.github/workflows/ci.yml",
    content: wf("jobs:\n  build:\n    runs-on: [self-hosted] # concurrency: prod\n    steps:\n      - run: make\n"),
    runners: [{ name: "r1", status: "online", busy: false, labels: ["self-hosted"] }],
    hasRunnerState: true,
  });
  assert.ok(!out.find((f) => f.rule === "mixed-hosted"));
});

// --- config ---

test("config rejects unknown keys rather than ignoring typos", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "rq-"));
  const file = join(dir, "c.json");
  await writeFile(file, JSON.stringify({ thresholdMinuts: 5 }));
  await assert.rejects(() => loadConfig({ path: file }), /unknown key/);
});

test("config rejects onlyRepos and ignoreRepos together", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "rq-"));
  const file = join(dir, "c.json");
  await writeFile(file, JSON.stringify({ onlyRepos: ["a"], ignoreRepos: ["b"] }));
  await assert.rejects(() => loadConfig({ path: file }), /not both/);
});

test("an explicit --config that is missing is reported, not ignored", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "rq-"));
  await assert.rejects(() => loadConfig({ path: join(dir, "nope.json") }), /no such file/);
});

test("write actions are off unless explicitly enabled", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "rq-"));
  const config = await loadConfig({ cwd: dir });
  assert.equal(config.source, "defaults");
  assert.equal(config.write.allowCancel, false);
  assert.equal(config.write.allowRerun, false);
});

test("filterRepos honours onlyRepos and ignoreRepos", () => {
  const repos = [
    { name: "api", full_name: "acme/api" },
    { name: "web", full_name: "acme/web" },
    { name: "docs", full_name: "acme/docs" },
  ];
  assert.deepEqual(
    filterRepos(repos, { onlyRepos: ["api"], ignoreRepos: [] }).map((r) => r.name),
    ["api"],
  );
  assert.deepEqual(
    filterRepos(repos, { onlyRepos: [], ignoreRepos: ["docs"] }).map((r) => r.name),
    ["api", "web"],
  );
});

test("lint explains a dynamic runs-on instead of calling it a defect", () => {
  // A reusable workflow that takes the runner label as an input cannot be
  // resolved by reading YAML, so it is an observation, not a warning to fix.
  const out = lintWorkflow({
    path: "acme/reusable:.github/workflows/ci.yml",
    content: wf("jobs:\n  build:\n    runs-on: ${{ inputs.runner-label }}\n    steps:\n      - run: make\n"),
    runners: null,
    hasRunnerState: false,
  });
  const finding = out.find((f) => f.rule === "dynamic-labels");
  assert.ok(finding);
  assert.equal(finding.level, "info");
  assert.equal(out.find((f) => f.rule === "no-labels"), undefined);
});

test("lint treats a flow-sequence runs-on as one conjunction, not alternatives", () => {
  // Regression: `[self-hosted, macos]` was split into separate entries, so
  // `macos` alone was tested and appeared to match a linux-only runner.
  const out = lintWorkflow({
    path: "acme/api:.github/workflows/ci.yml",
    content: wf("jobs:\n  build:\n    runs-on: [self-hosted, macos]\n    steps:\n      - run: make\n"),
    runners: [{ name: "r1", status: "online", busy: false, labels: ["self-hosted", "linux"] }],
    hasRunnerState: true,
  });
  assert.ok(out.find((f) => f.rule === "unmatched-labels"));
});
