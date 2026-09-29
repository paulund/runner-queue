/**
 * Text output for the same engine the UI uses. This is what an agent (or you,
 * in a terminal) calls: no browser, no polling, JSON-friendly with --json.
 */
import { listOrgRepos, listOrgRunners, collectQueue, collectHistory } from "./github.js";
import { buildQueue, capacitySummary } from "./diagnose.js";
import { findSuperseded, recommendFleet, runnerStats } from "./insights.js";
import { cacheFile } from "./config.js";

const mmss = (s) => {
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}m ${t % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

export async function cmdWhy(config, { json = false } = {}) {
  const repos = await listOrgRepos(config.orgs[0]);
  const { runners, error } = await listOrgRunners(config.orgs[0]);
  const perRepo = await collectQueue(repos);
  const jobs = buildQueue(perRepo, error ? null : runners, {
    thresholdS: config.thresholdMinutes * 60,
  });

  if (json) {
    return JSON.stringify(
      { jobs, runnerError: error, capacity: capacitySummary(error ? null : runners) },
      null,
      2,
    );
  }

  if (!jobs.length) {
    return "The queue is empty. Nothing is waiting for a runner.";
  }

  const lines = [
    `${jobs.length} job(s) queued across ${perRepo.length} repo(s).`,
    "",
  ];

  const worst = jobs[0];
  lines.push(
    `Worst: ${worst.repo} ${worst.branch} → ${worst.jobName}`,
    `  waiting ${mmss(worst.waitS)}`,
    `  cause: ${worst.cause}`,
    `  ${worst.detail}`,
    "",
  );

  const stuck = jobs.filter((j) => j.waitS >= config.thresholdMinutes * 60);
  if (stuck.length > 1) {
    lines.push(`All jobs over ${config.thresholdMinutes}m:`);
    for (const j of stuck) {
      lines.push(
        `  ${mmss(j.waitS).padStart(8)}  ${j.repo}/${j.branch} ${j.jobName} [${j.cause}]`,
      );
    }
    lines.push("");
  }

  if (error) {
    lines.push(`Runner capacity unknown: ${error.message}`);
    if (error.fix) lines.push(`  fix: ${error.fix}`);
  } else {
    const cap = capacitySummary(runners);
    lines.push(`Runners: ${cap.idle} free, ${cap.busy} busy, ${cap.offline} offline (${cap.total} total).`);
  }

  return lines.join("\n");
}

export async function cmdWait(config, { json = false } = {}) {
  const repos = await listOrgRepos(config.orgs[0]);
  const history = await collectHistory(repos, {
    days: config.historyDays,
    sample: config.historySample,
    cachePath: cacheFile(config),
  });

  if (json) return JSON.stringify(history, null, 2);

  const o = history.overall;
  const ttg = history.timeToGreen;

  return [
    `Wait times over the last ${history.daily.length} day(s) with completed runs, ${o.n} job samples.`,
    "",
    `  median wait   ${mmss(o.p50)}`,
    `  p90 wait      ${mmss(o.p90)}   (n=${o.n})`,
    `  worst wait    ${mmss(o.max)}`,
    "",
    `  median run    ${mmss(ttg.p50)} created to finished`,
    `  queue share   ${(ttg.waitShare * 100).toFixed(0)}% of that is queue wait`,
    "",
    `  blocked CI    ${history.blockedHours.totalHours.toFixed(0)} job-hours across ${history.blockedHours.days} day(s)`,
    "",
    "Worst workflows:",
    ...history.workflows.slice(0, 6).map(
      (w) =>
        `  ${mmss(w.p90).padStart(8)} p90  n=${String(w.n).padStart(3)}  ${w.repo} ${w.workflow}`,
    ),
  ].join("\n");
}

export async function cmdFleet(config, { json = false } = {}) {
  const org = config.orgs[0];
  const repos = await listOrgRepos(org);
  const { runners, error } = await listOrgRunners(org);
  const history = await collectHistory(repos, {
    days: config.historyDays,
    sample: config.historySample,
    cachePath: cacheFile(config),
  });
  const capacity = capacitySummary(error ? null : runners);
  const rec = recommendFleet({ history, capacity, fleet: config.fleet });

  if (json) return JSON.stringify({ rec, capacity }, null, 2);
  if (!rec.ok) {
    return `Cannot size the fleet: ${rec.reason.replace(/_/g, " ")}.`;
  }

  const lines = [
    `Demand   ${rec.demandHoursPerDay.toFixed(1)} runner-hours per day`,
    `Supply   ${rec.supplyHoursPerDay.toFixed(0)} runner-hours per day (${capacity.total} runners)`,
    `Use      ${(rec.utilisation * 100).toFixed(0)}% at target ${(config.fleet.targetUtilisation * 100).toFixed(0)}%`,
    `Idle     ${(rec.idleShare * 100).toFixed(0)}% of runners currently free`,
    `Blocked  ${rec.blockedHoursPerDay.toFixed(0)} job-hours per day waiting`,
    "",
  ];

  if (rec.reason) {
    lines.push(rec.reason);
  } else if (rec.verdict === "saturated") {
    lines.push(`Verdict: add ${rec.add} runner(s).`);
  } else if (rec.verdict === "tight") {
    lines.push("Verdict: close to saturation. Watch it; no change needed yet.");
  } else {
    lines.push("Verdict: healthy. Adding runners would waste money.");
  }

  return lines.join("\n");
}

export async function cmdSuperseded(config, { json = false } = {}) {
  const org = config.orgs[0];
  const repos = await listOrgRepos(org);
  const { runners, error } = await listOrgRunners(org);
  const perRepo = await collectQueue(repos);
  const jobs = buildQueue(perRepo, error ? null : runners, {
    thresholdS: config.thresholdMinutes * 60,
  });
  const superseded = findSuperseded(jobs);

  if (json) return JSON.stringify(superseded, null, 2);
  if (!superseded.length) {
    return "No queued runs have been superseded by a newer run on the same branch.";
  }

  return [
    `${superseded.length} queued run(s) are superseded by newer runs on the same branch:`,
    "",
    ...superseded.map(
      (j) =>
        `  ${mmss(j.waitS).padStart(8)}  ${j.repo} ${j.branch} (run ${j.runNumber}) superseded by run ${j.supersededBy.runId}`,
    ),
    "",
    "Run `runner-queue cancel <run-id>` to clear one.",
  ].join("\n");
}

export async function cmdRunners(config, { json = false } = {}) {
  const org = config.orgs[0];
  const { runners, error } = await listOrgRunners(org);
  if (error) {
    return json
      ? JSON.stringify({ error }, null, 2)
      : `${error.message}\n  fix: ${error.fix ?? "check your token scopes"}`;
  }
  if (json) return JSON.stringify(runners, null, 2);

  if (!runners.length) return "No self-hosted runners registered on this organisation.";

  return runners
    .map((r) => {
      const state = r.status !== "online" ? "offline" : r.busy ? "busy" : "free";
      return `${state.padEnd(8)} ${r.name.padEnd(18)} ${r.labels.join(", ")}`;
    })
    .join("\n");
}

export async function cmdCancel(config, runId) {
  const org = config.orgs[0];
  if (!config.write.allowCancel) {
    return [
      "Refusing to cancel: write actions are disabled.",
      "",
      "To enable, set write.allowCancel to true in runner-queue.config.json:",
      '  { "write": { "allowCancel": true } }',
      "",
      "Cancelling a queued run is safe -- nothing has run yet -- but it is a",
      "change to someone else's CI, so it has to be opt-in.",
    ].join("\n");
  }

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  // Accept a bare run id and find which repo it belongs to.
  const repos = await listOrgRepos(org);
  for (const repo of repos) {
    try {
      const { stdout } = await run("gh", [
        "api",
        `/repos/${repo.full_name}/actions/runs/${runId}`,
      ]);
      const parsed = JSON.parse(stdout);
      if (!parsed.id) continue;

      // Second guard against the dependabot trap: a `dynamic` run reports the
      // base branch, so "superseded" reasoning must never reach one.
      if (parsed.event === "dynamic") {
        return [
          `Refusing to cancel run ${runId} in ${repo.full_name}.`,
          "",
          `It was triggered by "${parsed.event}" (usually Dependabot). These runs`,
          "all report the base branch as their head branch, so they look like",
          "superseded runs when they are actually separate dependency updates.",
          "",
          `Cancel it directly if you are sure: https://github.com/${repo.full_name}/actions/runs/${runId}`,
        ].join("\n");
      }

      await run("gh", [
        "api",
        `/repos/${repo.full_name}/actions/runs/${runId}/cancel`,
        "-X",
        "POST",
      ]);
      return `Cancelled run ${runId} in ${repo.full_name}.`;
    } catch {
      // Not in this repo, or not cancellable; keep looking.
    }
  }
  return `Could not find run ${runId} in ${org}.`;
}
