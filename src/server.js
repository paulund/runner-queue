import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listOrgRepos,
  listOrgRunners,
  collectQueue,
  collectHistory,
  api,
} from "./github.js";
import { buildQueue, capacitySummary } from "./diagnose.js";
import { filterRepos, cacheFile } from "./config.js";
import {
  findSuperseded,
  recommendFleet,
  runnerStats,
  shouldAlert,
} from "./insights.js";
import { lintWorkflow } from "./lint.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function startServer(config, { port = 7777, host = "127.0.0.1" } = {}) {
  /** Short TTL on the live view; history is expensive so it caches hard. */
  let live = { at: 0, payload: null };
  let history = { at: 0, payload: null };
  let alertState = { lastFiredAt: null };
  const LIVE_TTL = 15_000;
  const HISTORY_TTL = 5 * 60_000;

  const org = config.orgs[0];

  async function loadRepos() {
    const repos = await listOrgRepos(org);
    return filterRepos(repos, config);
  }

  async function buildLive() {
    const now = Date.now();
    const repos = await loadRepos();
    const { runners, error: runnerError } = await listOrgRunners(org);
    const perRepo = await collectQueue(repos, { now });
    const thresholdS = config.thresholdMinutes * 60;
    const jobs = buildQueue(perRepo, runnerError ? null : runners, { now, thresholdS });

    return {
      org,
      now,
      thresholdS,
      runnerError,
      capacity: capacitySummary(runnerError ? null : runners),
      summary: {
        queuedJobs: jobs.length,
        queuedRuns: perRepo.reduce((n, r) => n + r.queued.length, 0),
        inProgressRuns: perRepo.reduce((n, r) => n + r.inProgress.length, 0),
        stuckJobs: jobs.filter((j) => j.waitS >= thresholdS).length,
        oldestWaitS: jobs.length ? jobs[0].waitS : 0,
      },
      jobs,
      superseded: findSuperseded(jobs),
      inProgress: perRepo.flatMap((r) =>
        r.inProgress.map((run) => ({ ...run, repo: r.repo })),
      ),
      canWrite: config.write,
    };
  }

  async function buildHistory() {
    const repos = await loadRepos();
    const hist = await collectHistory(repos, {
      days: config.historyDays,
      sample: config.historySample,
      cachePath: cacheFile(config),
    });
    const { runners, error: runnerError } = await listOrgRunners(org);
    const capacity = capacitySummary(runnerError ? null : runners);

    return {
      ...hist,
      fleet: recommendFleet({ history: hist, capacity, fleet: config.fleet }),
      runners: runnerStats(hist.samples ?? []),
    };
  }

  /** Lints every workflow in the org against the real runner labels. */
  async function buildLint() {
    const repos = await loadRepos();
    const { runners, error: runnerError } = await listOrgRunners(org);
    const results = [];

    for (const repo of repos) {
      let files = [];
      try {
        const data = await api(
          `/repos/${repo.full_name}/contents/.github/workflows?ref=${
            config.defaultBranch ?? "main"
          }`,
        );
        files = (Array.isArray(data) ? data : []).filter((f) =>
          /\.ya?ml$/.test(f.name),
        );
      } catch {
        continue;
      }

      for (const file of files) {
        let content = "";
        try {
          const data = await api(
            `/repos/${repo.full_name}/contents/${file.path}?ref=${
              config.defaultBranch ?? "main"
            }`,
          );
          content = Buffer.from(data.content ?? "", "base64").toString("utf8");
        } catch {
          continue;
        }
        const findings = lintWorkflow({
          path: `${repo.full_name}:${file.path}`,
          content,
          runners,
          hasRunnerState: !runnerError,
        });
        if (findings.length) results.push(...findings);
      }
    }
    return results;
  }

  async function maybeAlert(payload) {
    if (!config.alerts.enabled) return null;
    if (!config.alerts.webhookUrl) {
      return { skipped: true, reason: "no webhookUrl configured" };
    }
    const decision = shouldAlert({
      jobs: payload.jobs,
      thresholdS: payload.thresholdS,
      sustainedMinutes: config.alerts.sustainedMinutes,
      state: { ...alertState, cooldownMinutes: config.alerts.cooldownMinutes },
    });
    if (!decision.fire) return decision;

    const body = {
      text: [
        `Queue alert for ${org}`,
        `${decision.stuckJobs} job(s) stuck, oldest waiting ${Math.round(decision.worstWaitS / 60)}m`,
        `causes: ${Object.entries(decision.causes)
          .map(([k, v]) => `${k}×${v}`)
          .join(", ")}`,
      ].join("\n"),
    };

    try {
      await fetch(config.alerts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      alertState.lastFiredAt = Date.now();
      return { fired: true };
    } catch (err) {
      return { fired: false, error: String(err?.message ?? err) };
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (data) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

    try {
      if (url.pathname === "/api/queue") {
        if (!live.payload || Date.now() - live.at > LIVE_TTL) {
          live = { at: Date.now(), payload: await buildLive() };
          maybeAlert(live.payload).catch(() => {});
        }
        return json(live.payload);
      }

      if (url.pathname === "/api/history") {
        if (!history.payload || Date.now() - history.at > HISTORY_TTL) {
          history = { at: Date.now(), payload: await buildHistory() };
        }
        return json(history.payload);
      }

      if (url.pathname === "/api/lint") {
        return json({ findings: await buildLint() });
      }

      // Write actions. Both are opt-in and both are POST-only.
      if (req.method === "POST" && url.pathname.startsWith("/api/runs/")) {
        const segments = url.pathname.split("/").filter(Boolean);
        const action = segments[3];
        const runId = segments[2];

        if (action === "cancel" && !config.write.allowCancel) {
          res.writeHead(403, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({ error: "write.allowCancel is not enabled" }),
          );
        }
        if (action === "rerun" && !config.write.allowRerun) {
          res.writeHead(403, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({ error: "write.allowRerun is not enabled" }),
          );
        }
        if (action !== "cancel" && action !== "rerun") {
          res.writeHead(404).end();
          return;
        }

        const repo = url.searchParams.get("repo");
        if (!repo) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "repo query param required" }));
        }

        try {
          await api(`/repos/${repo}/actions/runs/${runId}/${action}`, {
            method: "POST",
          });
          live = { at: 0, payload: null };
          return json({ ok: true, action, runId: Number(runId) });
        } catch (err) {
          res.writeHead(502, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({ error: String(err?.message ?? err) }),
          );
        }
      }

      // Read-only snapshot, safe to share: no token, no write capability.
      if (url.pathname === "/snapshot") {
        if (!live.payload || Date.now() - live.at > LIVE_TTL) {
          live = { at: Date.now(), payload: await buildLive() };
        }
        const p = live.payload;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(renderSnapshot(p));
      }

      if (url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }

      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const body = await readFile(join(publicDir, file));
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "text/plain" });
      res.end(body);
    } catch (err) {
      // Never leak the raw `gh` stderr into the response: it is noisy, it can
      // contain a rate-limit request id, and the UI has no use for it.
      const message = friendlyError(err);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`runner-queue → ${url}  (org: ${org})`);
    console.log(`  snapshot: ${url}/snapshot`);
    if (process.platform === "darwin") {
      import("node:child_process").then(({ execFile }) =>
        execFile("open", [url], () => {}),
      );
    }
  });

  return server;
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** Turns a `gh` failure into one line a person can act on. */
export function friendlyError(err) {
  const text = String(err?.stderr ?? err?.message ?? err ?? "");
  if (text.includes("rate limit")) {
    return "GitHub's rate limit was reached. Wait for it to reset, or lower historySample in your config.";
  }
  if (text.includes("admin:org")) {
    return "Runner capacity needs the admin:org scope: gh auth refresh -h github.com -s admin:org";
  }
  if (text.includes("Bad credentials") || text.includes("401")) {
    return "GitHub rejected the credentials. Run gh auth login.";
  }
  return "Could not reach GitHub. Run `gh auth status` to check.";
}

const hhmm = (s) => {
  const t = Math.max(0, Math.floor(s));
  return `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(
    Math.floor((t % 3600) / 60),
  ).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** A self-contained page for sharing with someone who has no access to run this. */
function renderSnapshot(p) {
  const rows = p.jobs
    .map(
      (j) => `<tr class="${j.waitS >= p.thresholdS ? "stuck" : ""}">
      <td class="wait">${hhmm(j.waitS)}</td>
      <td>${esc(j.repo)}<br><span class="dim">${esc(j.branch)}</span></td>
      <td>${esc(j.jobName)}</td>
      <td class="dim">${esc(j.labels.join(" "))}</td>
      <td>${esc(j.detail)}</td>
    </tr>`,
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>runner queue — ${esc(p.org)}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+Condensed:wght@400;700&display=swap" rel="stylesheet">
<style>
  body{background:#e8e9e6;color:#14161a;font:15px/1.5 "IBM Plex Sans",system-ui,sans-serif;margin:0;padding:0 28px 56px}
  .top{height:6px;background:#14161a;margin:0 -28px}
  h1{font-family:"IBM Plex Sans Condensed",sans-serif;font-size:26px;margin:22px 0 2px}
  .meta{font-family:"IBM Plex Mono",monospace;font-size:11px;color:#5c6169;margin-bottom:20px}
  .tallies{display:flex;gap:28px;margin:18px 0 24px}
  .tallies b{font-family:"IBM Plex Sans Condensed",sans-serif;font-size:30px;display:block;line-height:1}
  .tallies span{font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#5c6169}
  table{width:100%;border-collapse:collapse}
  th{font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#5c6169;text-align:left;border-bottom:1px solid #14161a;padding:0 12px 6px 0}
  td{padding:10px 12px 10px 0;border-bottom:1px dotted #c7cbc6;vertical-align:top;font-size:13.5px}
  .wait{font-family:"IBM Plex Sans Condensed",sans-serif;font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
  .stuck .wait{color:#c4341b}
  .dim{color:#5c6169}
  .empty{color:#5c6169;padding:24px 0}
  footer{font-family:"IBM Plex Mono",monospace;font-size:10px;color:#5c6169;margin-top:22px}
</style></head><body>
<div class="top"></div>
<h1>runner queue — ${esc(p.org)}</h1>
<p class="meta">snapshot taken ${new Date(p.now).toISOString()} · stuck threshold ${Math.round(p.thresholdS / 60)}m</p>
<div class="tallies">
  <div><b>${p.summary.queuedJobs}</b><span>queued jobs</span></div>
  <div><b>${p.summary.inProgressRuns}</b><span>running</span></div>
  <div><b>${p.summary.stuckJobs}</b><span>stuck</span></div>
  <div><b>${p.capacity ? `${p.capacity.idle}/${p.capacity.total}` : "—"}</b><span>runners free</span></div>
</div>
${
  rows
    ? `<table><thead><tr><th>waiting</th><th>run</th><th>job</th><th>needs</th><th>why</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="empty">The queue is empty.</p>`
}
<footer>Read-only snapshot from runner-queue. No controls, no credentials.</footer>
</body></html>`;
}
