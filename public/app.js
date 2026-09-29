const $ = (id) => document.getElementById(id);

const hhmmss = (s) => {
  const t = Math.max(0, Math.floor(s));
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  return `${h}:${m}:${String(t % 60).padStart(2, "0")}`;
};

const shortWait = (s) => {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};

const CAUSE_TAGS = {
  scheduling: "free runner",
  all_busy: "all busy",
  no_runners_online: "no runners online",
  label_mismatch: "label mismatch",
  unknown_capacity: "unknown",
};

let payload = null;
let fetchedAt = 0;

function renderHero() {
  const hero = $("hero");
  const worst = payload.jobs[0];
  if (!worst) {
    hero.hidden = false;
    hero.classList.remove("is-signal");
    $("hero-clock").textContent = "00:00:00";
    $("hero-job").textContent = "Nothing is waiting.";
    $("hero-cause").textContent =
      "Every queued job has been picked up. A quiet queue is a healthy queue.";
    return;
  }
  hero.hidden = false;
  hero.classList.toggle("is-signal", worst.waitS >= payload.thresholdS);
  $("hero-job").innerHTML = `<span class="repo">${worst.repo}</span> · ${
    worst.branch
  } · ${worst.jobName}`;
  $("hero-cause").textContent = worst.detail;
}

function renderCapacity() {
  const el = $("capacity");
  if (payload.runnerError) {
    el.innerHTML = `<div class="warn-box">${payload.runnerError.message}<code>${payload.runnerError.fix}</code></div>`;
    return;
  }
  const cap = payload.capacity;
  if (!cap.total) {
    el.innerHTML = `<p class="capacity-note">No self-hosted runners registered on this organisation.</p>`;
    return;
  }
  el.innerHTML =
    cap.lanes
      .map((l) => {
        const state = l.status !== "online" ? "offline" : l.busy ? "busy" : "online";
        const text =
          l.status !== "online" ? "offline" : l.busy ? "busy" : "free";
        return `<div class="lane ${state}"><span class="lamp"></span><span class="lane-name" title="${l.labels.join(", ")}">${l.name}</span><span class="lane-state">${text}</span></div>`;
      })
      .join("") +
    `<p class="capacity-note">${cap.idle} of ${cap.total} runners free. Hover a name for its labels.</p>`;
}

function renderBoard() {
  const board = $("board");
  if (!payload.jobs.length) {
    board.innerHTML = `<p class="empty">The queue is empty. ${payload.summary.inProgressRuns} run(s) in progress.</p>`;
    return;
  }
  const head = `<div class="board-head"><span>waiting</span><span>job</span><span>needs</span><span>why</span></div>`;
  const rows = payload.jobs
    .map((j) => {
      const cls = j.waitS >= payload.thresholdS ? "stuck" : j.severity === "warn" ? "warn" : "";
      return `<div class="row ${cls}">
        <span class="wait">${hhmmss(j.waitS)}</span>
        <span class="job"><a class="repo" href="${j.url}" target="_blank" rel="noreferrer">${j.repo}</a><br>${j.jobName}</span>
        <span class="job">${j.labels.join(" ") || "—"}</span>
        <span class="cause"><span class="cause-tag">${CAUSE_TAGS[j.cause] ?? j.cause}</span>${j.detail}</span>
      </div>`;
    })
    .join("");
  board.innerHTML = head + rows;
}

function renderTallies() {
  const s = payload.summary;
  $("tally-queued").textContent = s.queuedJobs;
  $("tally-running").textContent = s.inProgressRuns;
  $("tally-stuck").textContent = s.stuckJobs;
}

/** Queued runs a newer run of the same commit has made pointless. */
function renderSuperseded() {
  const el = $("superseded");
  const list = payload.superseded ?? [];
  if (!list.length) {
    el.innerHTML = "";
    return;
  }
  const freeable = list.reduce((n, j) => n + j.waitS, 0);
  el.innerHTML = `
    <h2 class="sub-head">wasted queue</h2>
    <p class="note">${list.length} queued run(s) are duplicates of a newer
    run of the same commit, holding ${shortWait(freeable)} of queue position.</p>
    <ul class="mini-list">
      ${list
        .slice(0, 5)
        .map(
          (j) =>
            `<li><a href="${j.url}" target="_blank" rel="noreferrer">${j.repo}</a>
            ${j.branch} <span class="dim">run ${j.runNumber}</span></li>`,
        )
        .join("")}
    </ul>
    <p class="note">Clear with <code>runner-queue superseded</code>.</p>`;
}

function renderFleet(hist) {
  const el = $("fleet");
  const f = hist?.fleet;
  if (!f) {
    el.innerHTML = `<p class="empty">Could not size the fleet without reading your recent runs.</p>`;
    return;
  }
  if (!f.ok) {
    el.innerHTML = `<p class="empty">${
      f?.reason === "no_runner_state"
        ? "Sizing the fleet needs runner state. Run <code>gh auth refresh -h github.com -s admin:org</code>."
        : "Not enough completed runs yet to size the fleet."
    }</p>`;
    return;
  }

  const verdict =
    f.verdict === "saturated"
      ? `Add ${f.add} runner${f.add === 1 ? "" : "s"}.`
      : f.verdict === "tight"
        ? "Close to saturation. No change needed yet."
        : "Healthy. More runners would waste money.";

  el.innerHTML = `
    <p class="verdict ${f.verdict}">${verdict}</p>
    ${f.reason ? `<p class="note">${f.reason}</p>` : ""}
    <div class="stats-row">
      <div><div class="stat-label">demand</div><div class="stat-value">${f.demandHoursPerDay.toFixed(0)}h<small>/day</small></div></div>
      <div><div class="stat-label">supply</div><div class="stat-value">${f.supplyHoursPerDay.toFixed(0)}h<small>/day</small></div></div>
      <div><div class="stat-label">in use</div><div class="stat-value">${(f.utilisation * 100).toFixed(0)}%</div></div>
      <div><div class="stat-label">blocked</div><div class="stat-value">${f.blockedHoursPerDay.toFixed(0)}h<small>/day</small></div></div>
    </div>`;
}

function renderLint(findings) {
  const el = $("lint");
  if (!findings?.length) {
    el.innerHTML = `<p class="empty">Nothing to flag. Workflows line up with your runners.</p>`;
    return;
  }
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.level] = (counts[f.level] ?? 0) + 1;

  el.innerHTML = `
    <p class="note">
      ${counts.error} error${counts.error === 1 ? "" : "s"},
      ${counts.warn} warning${counts.warn === 1 ? "" : "s"},
      ${counts.info} note${counts.info === 1 ? "" : "s"}.
    </p>
    <ul class="findings">
      ${findings
        .slice(0, 12)
        .map(
          (f) => `<li class="level-${f.level}">
            <span class="level-tag">${f.level}</span>
            <span class="finding-text">${f.message}</span>
            <code class="finding-path">${f.path}</code>
          </li>`,
        )
        .join("")}
    </ul>
    ${findings.length > 12 ? `<p class="note">and ${findings.length - 12} more.</p>` : ""}`;
}

function paint() {
  if (!payload) return;
  $("org").textContent = payload.org;
  $("foot-org").textContent = `threshold ${shortWait(payload.thresholdS)}`;
  $("foot-refresh").textContent = `updated ${new Date(fetchedAt).toLocaleTimeString()}`;
  renderTallies();
  renderHero();
  renderCapacity();
  renderSuperseded();
  renderBoard();
}

/** Ticks the hero clock between polls so the wait feels live, not static. */
function startTicking() {
  setInterval(() => {
    if (!payload?.jobs.length) return;
    const drift = (Date.now() - fetchedAt) / 1000;
    $("hero-clock").textContent = hhmmss(payload.jobs[0].waitS + drift);
  }, 1000);
}

async function poll() {
  try {
    const res = await fetch("/api/queue");
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error ?? `server returned ${res.status}`);
    }
    payload = await res.json();
    fetchedAt = Date.now();
    $("offline").hidden = true;
    paint();
  } catch (err) {
    $("offline").hidden = false;
    $("offline-text").textContent = err.message;
    $("foot-refresh").textContent = "not updating";
  }
}

async function loadHistory() {
  const el = $("chart");
  let hist;
  try {
    const res = await fetch("/api/history?days=30");
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error ?? `server returned ${res.status}`);
    }
    hist = await res.json();
  } catch (err) {
    el.innerHTML = `<p class="empty">${err.message}</p>`;
    $("chart-legend").innerHTML = "";
    renderFleet(null);
    // The banner already carries this message once; repeating it in three
    // panels turns one problem into three.
    for (const id of ["fleet", "lint"]) {
      $(id).innerHTML = `<p class="empty">Also unavailable while GitHub is unreachable.</p>`;
    }
    return;
  }

  const daily = hist.daily ?? [];
  if (!daily.length) {
    el.innerHTML = `<p class="empty">Not enough completed runs yet to chart.</p>`;
    return;
  }

  const max = Math.max(...daily.map((d) => d.p90), 60);
  el.innerHTML = `<div class="chart">${daily
    .map((d) => {
      const h = Math.max(2, (d.p90 / max) * 100);
      return `<div class="bar ${d.p90 >= 600 ? "p90" : ""}" style="height:${h}%" data-tip="${d.day} · p90 ${shortWait(d.p90)} · n=${d.n}"></div>`;
    })
    .join("")}</div>`;

  const o = hist.overall;
  $("chart-legend").innerHTML = `
    <div class="stats-row">
      <div><div class="stat-label">median wait</div><div class="stat-value">${shortWait(o.p50)}</div></div>
      <div><div class="stat-label">p90 wait</div><div class="stat-value">${shortWait(o.p90)}</div></div>
      <div><div class="stat-label">worst</div><div class="stat-value">${shortWait(o.max)}</div></div>
      <div><div class="stat-label">jobs sampled</div><div class="stat-value">${o.n}</div></div>
    </div>
    <span><i class="swatch" style="background:var(--running)"></i> days under threshold</span>
    <span><i class="swatch" style="background:var(--signal)"></i> days over threshold</span>`;

  renderFleet(hist);
}

async function loadLint() {
  const el = $("lint");
  try {
    const res = await fetch("/api/lint");
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error ?? `server returned ${res.status}`);
    }
    const { findings } = await res.json();
    renderLint(findings);
  } catch (err) {
    el.innerHTML = `<p class="empty">${err.message}</p>`;
  }
}

poll();
startTicking();
setInterval(poll, 15_000);
loadHistory();
loadLint();
