import { matchesLabels } from "./diagnose.js";

/**
 * Lints workflow definitions against the runners that actually exist, so
 * queue-backing-up causes get caught in review rather than in production.
 *
 * This is a deliberately shallow YAML read: we look for the structural
 * decisions that affect queueing (runs-on, concurrency, timeout-minutes) and
 * do not attempt a full YAML parse, which would need a dependency.
 */
export function lintWorkflow({ path, content, runners, hasRunnerState }) {
  const findings = [];
  const text = content;

  // Strip comments so commented-out config is not flagged.
  const code = text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");

  const add = (level, rule, message) =>
    findings.push({ level, rule, message, path });

  // --- runs-on labels vs real runners ---

  const runsOn = extractRunsOn(code);
  if (runsOn.length === 0) {
    add(
      "info",
      "no-runs-on",
      "No runs-on found; this is likely a reusable workflow that passes the " +
        "label to its jobs, or a workflow_dispatch-only helper.",
    );
  }

  for (const entry of runsOn) {
    const labels = normaliseLabels(entry);

    if (labels.length === 0) {
      // Not a defect: a reusable workflow taking the runner label as an input
      // cannot be resolved by reading YAML alone. Saying so is more useful
      // than flagging it as a problem to fix.
      if (entry.includes("${{")) {
        add(
          "info",
          "dynamic-labels",
          `runs-on "${entry}" is decided at call time, so it cannot be checked here. ` +
            "Check the value the caller passes.",
        );
      } else {
        add("warn", "no-labels", `runs-on "${entry}" has no resolvable labels.`);
      }
      continue;
    }

    // A GitHub-hosted label on a self-hosted fleet silently doubles your
    // bill and confuses everyone reading the queue.
    const hosted = labels.filter((l) =>
      ["ubuntu-latest", "ubuntu-24.04", "macos-latest", "windows-latest", "macos-14"].includes(l),
    );
    if (hosted.length && labels.includes("self-hosted")) {
      add(
        "warn",
        "mixed-hosted",
        `runs-on mixes self-hosted with GitHub-hosted labels (${hosted.join(", ")}); ` +
          "these jobs will bill per minute and bypass your runners.",
      );
    }

    if (!hasRunnerState) {
      continue;
    }

    if (!labels.includes("self-hosted")) {
      continue;
    }

    const eligible = (runners ?? []).filter((r) => matchesLabels(r, labels));
    if (eligible.length === 0) {
      add(
        "error",
        "unmatched-labels",
        `runs-on ${JSON.stringify(labels)} matches no registered runner. Jobs ` +
          "will queue forever.",
      );
    } else if (!eligible.some((r) => r.status === "online")) {
      add(
        "error",
        "all-offline",
        `runs-on ${JSON.stringify(labels)} matches only offline runners ` +
          `(${eligible.map((r) => r.name).join(", ")}).`,
      );
    }
  }

  // --- concurrency ---

  if (!/^\s*concurrency\s*:/m.test(code)) {
    add(
      "info",
      "no-concurrency",
      "No concurrency group: overlapping runs of this workflow all queue, " +
        "which is a common cause of a backed-up self-hosted queue.",
    );
  }

  // --- timeouts ---

  const jobBlocks = code.split(/\n(?=\s{0,4}\S)/);
  for (const block of jobBlocks) {
    if (!/^\s{0,4}steps\s*:|^\s{0,4}uses\s*:|^\s{0,4}run\s*:/m.test(block)) continue;
    if (!/timeout-minutes\s*:/.test(block)) {
      const name = block.match(/^\s{0,4}([A-Za-z0-9_-]+)\s*:/)?.[1] ?? "a job";
      add(
        "info",
        "no-timeout",
        `Job "${name}" has no timeout-minutes; a hung job occupies a runner ` +
          "until GitHub's 6-hour default.",
      );
      break; // one example is enough to make the point
    }
  }

  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return findings;
}

function extractRunsOn(code) {
  const out = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*runs-on\s*:\s*(.+)$/);
    if (!m) continue;
    const inline = m[1].trim();

    // A flow sequence is a single job's AND-ed label list:
    //   runs-on: [self-hosted, linux]
    // It must be kept as one entry. Splitting it would test each label on its
    // own and wrongly conclude that `macos` alone matches an available runner.
    if (inline.startsWith("[")) {
      out.push(inline);
      continue;
    }

    if (inline.startsWith("${{")) {
      // Matrix value: look back a few lines for the matrix definition.
      const window = lines.slice(Math.max(0, i - 12), i).join("\n");
      const values = [
        ...window.matchAll(
          /^\s*(?:runs-on|runs_on)\s*:\s*\[(.*)\]\s*$/gm,
        ),
      ].flatMap((mm) =>
        mm[1]
          .split(",")
          .map((v) => v.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean),
      );
      if (values.length) out.push(...values);
      else out.push(inline);
      continue;
    }

    out.push(inline.replace(/^["']|["']$/g, ""));
  }
  return out;
}

function normaliseLabels(entry) {
  let labels = entry;
  if (labels.startsWith("[")) {
    labels = labels.replace(/[[\]]/g, "");
  }
  return labels
    .split(",")
    .map((v) => v.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .filter((v) => !v.startsWith("${{"));
}
