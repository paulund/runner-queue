import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQueue,
  capacitySummary,
  diagnoseJob,
  matchesLabels,
  runnersForOrg,
} from "../src/diagnose.js";

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

const queuedJob = (over = {}) => ({
  id: 11,
  name: "build",
  labels: ["self-hosted", "linux"],
  created_at: "2026-01-01T00:00:00Z",
  ...over,
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
  const d = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
    [runner()],
    { now: Date.parse("2026-01-01T00:20:00Z") },
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

test("an offline runner is not reported as busy", () => {
  // Regression: offline runners were counted as occupied, so a job whose only
  // matching runner was switched off was reported as "everything is busy".
  const d = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
    [runner({ status: "offline", busy: false })],
    { now: Date.parse("2026-01-01T00:20:00Z") },
  );
  assert.equal(d.cause, "no_runners_online");
});

test("diagnoseJob separates no_runners_online from label_mismatch", () => {
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

test("a job whose only matching runners are offline says so, however many other runners are online", () => {
  // Regression: the offline branch compared the number of matching runners
  // with the number of online runners. With two offline macOS machines and five
  // online Linux ones that comparison failed, and a job that needed nothing but
  // a switched-on machine was reported as a label problem.
  const d = diagnoseJob(
    { labels: ["self-hosted", "macos"], created_at: "2026-01-01T00:00:00Z" },
    [
      runner({ name: "mac-1", status: "offline", labels: ["self-hosted", "macos"] }),
      runner({ name: "mac-2", status: "offline", labels: ["self-hosted", "macos"] }),
      ...Array.from({ length: 5 }, (_, i) =>
        runner({ id: 10 + i, name: `linux-${i + 1}`, labels: ["self-hosted", "linux"] }),
      ),
    ],
    { now: Date.parse("2026-01-01T00:20:00Z") },
  );

  assert.equal(d.cause, "runner_offline");
  assert.match(d.detail, /mac-1, mac-2/);
  assert.doesNotMatch(d.detail, /linux-1/);
});

test("diagnoseJob never guesses a cause when runner state is unknown", () => {
  const d = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
    null,
    { now: Date.parse("2026-01-01T00:20:00Z") },
  );
  assert.equal(d.cause, "unknown_capacity");
});

test("a job past the threshold is still diagnosed, not treated as unknowable", () => {
  // The threshold decides what counts as stuck, not whether a cause can be
  // found, so the cause is reported either way and the wait is what tells the
  // two apart.
  const now = Date.parse("2026-01-01T02:00:00Z");
  const over = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
    null,
    { now, thresholdS: 600 },
  );
  const under = diagnoseJob(
    { labels: ["self-hosted"], created_at: "2026-01-01T01:55:00Z" },
    null,
    { now, thresholdS: 600 },
  );
  assert.equal(over.cause, "unknown_capacity");
  assert.equal(under.cause, "unknown_capacity");
  assert.ok(over.waitS >= 600);
  assert.ok(under.waitS < 600);
});

const perRepo = (over = {}) => ({
  org: "acme",
  repo: "acme/api",
  queued: [
    {
      run: {
        id: 1,
        name: "Test",
        run_number: 1,
        event: "push",
        head_branch: "main",
        html_url: "u1",
      },
      jobs: [
        { id: 11, name: "quick", labels: ["self-hosted"], created_at: "2026-01-01T01:58:00Z" },
        { id: 12, name: "slow", labels: ["self-hosted"], created_at: "2026-01-01T00:00:00Z" },
      ],
    },
  ],
  inProgress: [],
  ...over,
});

test("buildQueue sorts by longest wait first", () => {
  const out = buildQueue([perRepo()], null, {
    now: Date.parse("2026-01-01T02:00:00Z"),
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].jobName, "slow");
  assert.equal(out[0].waitS, 7200);
  assert.equal(out[0].repo, "acme/api");
  assert.equal(out[0].org, "acme");
});

test("a job needing labels no runner in its own org carries is a mismatch", () => {
  // Runners are org-scoped on GitHub: a macOS machine in one organisation can
  // never take a job in another, and reporting `scheduling` here would send
  // somebody to wait for a runner that is not allowed to help them.
  const out = buildQueue(
    [
      perRepo({
        queued: [
          {
            run: { id: 1, name: "T", run_number: 1, event: "push", head_branch: "main", html_url: "u" },
            jobs: [
              {
                id: 11,
                name: "build",
                labels: ["self-hosted", "macos"],
                created_at: "2026-01-01T01:58:00Z",
              },
            ],
          },
        ],
      }),
    ],
    [
      // acme has a linux machine and nothing else.
      runner({ org: "acme", name: "acme-linux", labels: ["self-hosted", "linux"] }),
      // other has an idle macOS machine, which cannot serve an acme job.
      runner({ org: "other", name: "other-mac", labels: ["self-hosted", "macos"] }),
    ],
    { now: Date.parse("2026-01-01T02:00:00Z") },
  );

  assert.equal(out[0].cause, "label_mismatch");
  assert.match(out[0].detail, /No runner is labelled/);
});

test("an idle runner in the same organisation does satisfy a job", () => {
  const out = buildQueue(
    [perRepo()],
    [runner({ org: "acme", name: "mac-1", labels: ["self-hosted", "macos"] })],
    { now: Date.parse("2026-01-01T02:00:00Z") },
  );
  assert.equal(out[0].cause, "scheduling");
});

test("one org with unreadable runners does not make every other org unknown", () => {
  const out = buildQueue(
    [
      perRepo(),
      perRepo({ org: "other", repo: "other/api", queued: [], inProgress: [] }),
      perRepo({
        org: "third",
        repo: "third/api",
        queued: [
          {
            run: { id: 9, name: "T", run_number: 9, event: "push", head_branch: "main", html_url: "u" },
            jobs: [queuedJob({ labels: ["self-hosted"] })],
          },
        ],
      }),
    ],
    [runner({ org: "acme", name: "acme-1" })],
    {
      now: Date.parse("2026-01-01T02:00:00Z"),
      unknownOrgs: new Set(["third"]),
    },
  );

  const byRepo = Object.fromEntries(out.map((j) => [j.repo, j.cause]));
  assert.equal(byRepo["acme/api"], "scheduling", "a readable org is still diagnosed");
  assert.equal(byRepo["third/api"], "unknown_capacity", "an unreadable org says so");
});

test("passing null runners means capacity is unknown everywhere", () => {
  const out = buildQueue([perRepo()], null, {
    now: Date.parse("2026-01-01T02:00:00Z"),
  });
  assert.equal(out[0].cause, "unknown_capacity");
});

test("runnersForOrg keeps runners with no org in scope, for single-org callers", () => {
  const unlabelled = runner();
  const labelled = runner({ org: "acme", name: "a1" });

  assert.deepEqual(runnersForOrg([unlabelled], "acme"), [unlabelled]);
  assert.deepEqual(runnersForOrg([labelled], "other"), []);
  assert.deepEqual(runnersForOrg([labelled], null), [labelled], "no org means no filter");
  assert.deepEqual(runnersForOrg([unlabelled, labelled], "acme"), [unlabelled, labelled]);
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

test("capacitySummary breaks the fleet down per organisation", () => {
  const out = capacitySummary([
    runner({ org: "acme", name: "a1" }),
    runner({ org: "acme", name: "a2", busy: true }),
    runner({ org: "other", name: "b1", status: "offline" }),
  ]);

  assert.equal(out.total, 3);
  assert.deepEqual(out.perOrg, [
    { org: "acme", total: 2, online: 2, busy: 1, idle: 1, offline: 0 },
    { org: "other", total: 1, online: 0, busy: 0, idle: 0, offline: 1 },
  ]);
});

