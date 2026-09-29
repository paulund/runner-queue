import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Calls `gh api` and parses JSON. Shelling out to the GitHub CLI means the
 * user's token stays in their keychain: we never see it, never log it, and
 * never put it in a browser.
 */
export async function api(path, { method = "GET" } = {}) {
  const args = ["api", path];
  if (method !== "GET") args.push("-X", method);
  const { stdout } = await run("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

async function paged(path, pages = 1) {
  const sep = path.includes("?") ? "&" : "?";
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const data = await api(`${path}${sep}per_page=100&page=${page}`);
    if (!data?.workflow_runs) break;
    out.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) break;
  }
  return out;
}

export async function listOrgRepos(org) {
  const repos = await api(
    `/orgs/${org}/repos?per_page=100&type=all`,
  );
  return (repos ?? [])
    .filter((r) => !r.archived)
    .map((r) => ({ name: r.name, full_name: r.full_name, private: r.private }));
}

/**
 * Org-level self-hosted runners. Requires an `admin:org` scoped token:
 *   gh auth refresh -h github.com -s admin:org
 * Returns `{ runners, error }` rather than throwing, because a missing scope
 * should degrade the UI to "queue visible, capacity unknown" instead of a
 * blank screen.
 */
export async function listOrgRunners(org) {
  try {
    const data = await api(`/orgs/${org}/actions/runners?per_page=100`);
    return {
      runners: (data?.runners ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        os: r.os,
        status: r.status,
        busy: r.busy,
        labels: r.labels.map((l) => l.name),
        ephemeral: r.ephemeral,
      })),
      error: null,
    };
  } catch (err) {
    const text = String(err?.stderr ?? err?.message ?? "");
    const needsScope = text.includes("admin:org") || text.includes("org admin");
    return {
      runners: [],
      error: needsScope
        ? {
            kind: "missing_scope",
            message:
              "Runner capacity is hidden until your token has the admin:org scope.",
            fix: "gh auth refresh -h github.com -s admin:org",
          }
        : {
            kind: "forbidden",
            message: "Could not list runners for this organisation.",
            fix: text.trim().slice(0, 200) || null,
          },
    };
  }
}

/**
 * The queue. `status=queued` runs plus their jobs: each job carries the
 * `runs-on` labels it needs and the runner that eventually took it (empty
 * while waiting). Run-level `run_started_at` is useless here -- GitHub sets it
 * equal to `created_at` even for runs that never started -- so all timing
 * comes from job timestamps.
 */
export async function collectQueue(repos, { now = Date.now() } = {}) {
  const perRepo = await Promise.all(
    repos.map(async (repo) => {
      const [queued, inProgress] = await Promise.all([
        paged(`/repos/${repo.full_name}/actions/runs?status=queued`, 2),
        paged(`/repos/${repo.full_name}/actions/runs?status=in_progress`, 1),
      ]);

      const jobLists = await Promise.all(
        queued.map(async (run) => {
          const jobs = await api(
            `/repos/${repo.full_name}/actions/runs/${run.id}/jobs?per_page=100`,
          );
          return { run, jobs: jobs?.jobs ?? [] };
        }),
      );

      return {
        repo: repo.full_name,
        queued: jobLists,
        inProgress: inProgress.map((run) => ({
          id: run.id,
          name: run.name,
          event: run.event,
          branch: run.head_branch,
          runNumber: run.run_number,
          url: run.html_url,
          startedAt: run.run_started_at,
          createdAt: run.created_at,
        })),
        now,
      };
    }),
  );

  return perRepo;
}

/**
 * Historical wait times, derived from completed runs. For each job that
 * actually started, wait = started_at - created_at. Those are the numbers
 * worth charting: p50/p90 per repo, per workflow, and per day.
 *
 * This is the expensive call: one request per run to read its jobs. Requests
 * are therefore fanned out with bounded concurrency -- GitHub throttles you
 * otherwise, and a fully serial walk over ~300 runs took minutes.
 */
export async function collectHistory(repos, { days = 30, sample = 40, concurrency = 8 } = {}) {
  const cutoff = Date.now() - days * 86_400_000;

  const runLists = await mapLimit(repos, concurrency, async (repo) => {
    try {
      const runs = await paged(
        `/repos/${repo.full_name}/actions/runs?status=completed`,
        1,
      );
      return runs
        .filter((r) => new Date(r.created_at).getTime() >= cutoff)
        .slice(0, sample)
        .map((run) => ({ repo, run }));
    } catch {
      return [];
    }
  });

  const flat = runLists.flat();

  const jobLists = await mapLimit(flat, concurrency, async ({ repo, run }) => {
    try {
      const data = await api(
        `/repos/${repo.full_name}/actions/runs/${run.id}/jobs?per_page=100`,
      );
      return (data?.jobs ?? []).map((job) => ({ repo, run, job }));
    } catch {
      return [];
    }
  });

  const jobs = [];
  for (const { repo, run, job } of jobLists.flat()) {
    if (!job.started_at || !job.created_at) continue;
    const waitS = Math.max(
      0,
      (new Date(job.started_at) - new Date(job.created_at)) / 1000,
    );
    jobs.push({
      repo: repo.full_name,
      runId: run.id,
      runName: run.name,
      event: run.event,
      conclusion: run.conclusion,
      runCreatedAt: run.created_at,
      runUpdatedAt: run.updated_at,
      jobCreatedAt: job.created_at,
      jobName: job.name,
      runnerName: job.runner_name ?? null,
      labels: job.labels ?? [],
      waitS,
      at: run.created_at,
    });
  }

  return summarise(jobs, { days });
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function stats(values) {
  if (!values.length) return { n: 0, p50: 0, p90: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

/** Turns raw job samples into the aggregates the UI charts. */
export function summarise(jobs, { days = 30 } = {}) {
  const byRepo = new Map();
  const byWorkflow = new Map();
  const byDay = new Map();

  for (const job of jobs) {
    const wait = job.waitS;
    const workflow = job.runName || "unknown";

    if (!byRepo.has(job.repo)) byRepo.set(job.repo, []);
    byRepo.get(job.repo).push(wait);

    // Workflow names contain spaces, so the map key is a JSON pair rather
    // than a delimited string.
    const wfKey = JSON.stringify([job.repo, workflow]);
    if (!byWorkflow.has(wfKey)) byWorkflow.set(wfKey, []);
    byWorkflow.get(wfKey).push(wait);

    const day = job.at.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(wait);
  }

  const daily = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-days)
    .map(([day, values]) => ({ day, ...stats(values) }));

  const workflows = [...byWorkflow.entries()]
    .map(([key, values]) => {
      const [repo, workflow] = JSON.parse(key);
      return { repo, workflow, ...stats(values) };
    })
    .sort((a, b) => b.p90 - a.p90);

  return {
    overall: stats(jobs.map((j) => j.waitS)),
    byRepo: [...byRepo.entries()]
      .map(([repo, values]) => ({ repo, ...stats(values) }))
      .sort((a, b) => b.p90 - a.p90),
    workflows,
    daily,
    failures: jobs.filter((j) => j.conclusion === "failure").length,
    timeToGreen: timeToGreen(jobs),
    blockedHours: blockedHours(jobs, { days }),
    // Raw samples, kept so the insights layer can compute per-runner stats
    // without a second GitHub round trip.
    samples: jobs,
  };
}

/**
 * Time-to-green: for a run, when it finished minus when it was created. The
 * queue wait is only part of that; run duration is the rest, so this is the
 * number a developer actually feels when they push a branch.
 */
function timeToGreen(jobs) {
  const byRun = new Map();
  for (const job of jobs) {
    const key = `${job.repo}/${job.runId}`;
    const existing = byRun.get(key);
    if (existing) {
      existing.finishedAt = maxDate(existing.finishedAt, job.runUpdatedAt);
    } else {
      byRun.set(key, {
        createdAt: job.runCreatedAt,
        finishedAt: job.runUpdatedAt,
        waitS: job.waitS,
        conclusion: job.conclusion,
      });
    }
  }

  const totals = [...byRun.values()].filter((r) => r.finishedAt && r.createdAt);
  const durations = totals.map(
    (r) => (new Date(r.finishedAt) - new Date(r.createdAt)) / 1000,
  );

  return {
    ...stats(durations),
    waitShare: durations.length
      ? totals.reduce((n, r) => n + r.waitS, 0) /
        durations.reduce((n, d) => n + d, 0)
      : 0,
  };
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

/**
 * Blocked-CI hours: how long jobs sat ready but unassigned, summed per day.
 * This is the cost of the queue expressed in a unit a manager understands,
 * and the justification for adding runners.
 */
function blockedHours(jobs, { days }) {
  const daily = new Map();
  for (const job of jobs) {
    const day = job.at.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + job.waitS);
  }
  const series = [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-days)
    .map(([day, seconds]) => ({ day, blockedHours: seconds / 3600 }));
  const total = series.reduce((n, d) => n + d.blockedHours, 0);
  return { series, totalHours: total, days: series.length };
}
