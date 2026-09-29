#!/usr/bin/env node
import { loadConfig } from "./config.js";
import {
  cmdWhy,
  cmdWait,
  cmdFleet,
  cmdSuperseded,
  cmdRunners,
  cmdCancel,
} from "./commands.js";
import { startServer } from "./server.js";

const HELP = `runner-queue — see what your self-hosted runner queue is doing, and why.

Usage
  runner-queue [--org <name>] [options]           start the dashboard
  runner-queue <command> [options]

Commands
  why                     what is queued and why it is stuck
  wait                    wait-time analytics from recent runs
  fleet                   how many runners you actually need
  superseded              queued runs a newer run has made pointless
  runners                 runner status and labels
  cancel <run-id>         cancel a queued run (needs write.allowCancel)

Options
  --org <name>            GitHub organisation (repeatable, or use config)
  --port <n>              server port (default 7777)
  --threshold <minutes>   a job is "stuck" past this wait (default 10)
  --config <path>         config file (default ./runner-queue.config.json)
  --json                  machine-readable output
  -h, --help              this text

Setup
  gh auth login
  gh auth refresh -h github.com -s admin:org   # to see runner capacity
`;

const COMMANDS = [
  "why",
  "wait",
  "fleet",
  "superseded",
  "runners",
  "cancel",
];

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }

  // Flags are read from the whole argv, since `runner-queue why --org acme`
  // puts the command first and `runner-queue --org acme why` puts it last.
  const command = argv.find(
    (a) => !a.startsWith("-") && COMMANDS.includes(a),
  );

  const flagValue = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = argv[i + 1];
    return next === undefined || next.startsWith("--") ? true : next;
  };

  const config = await loadConfig({ path: flagValue("config") });

  // CLI flags win over the config file.
  const orgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org" && argv[i + 1]) orgs.push(argv[i + 1]);
  }
  if (orgs.length) config.orgs = orgs;
  else if (!config.orgs.length && process.env.RUNNER_QUEUE_ORG) {
    config.orgs = [process.env.RUNNER_QUEUE_ORG];
  }

  const threshold = flagValue("threshold");
  if (threshold != null && threshold !== true) {
    config.thresholdMinutes = Number(threshold);
  }

  const json = argv.includes("--json");

  if (command) {
    if (command === "cancel") {
      const i = argv.indexOf("cancel");
      const runId = argv[i + 1];
      if (!runId || runId.startsWith("--")) {
        process.stdout.write("Which run? Try: runner-queue cancel <run-id>\n");
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${await cmdCancel(config, runId)}\n`);
      return;
    }

    const table = {
      why: cmdWhy,
      wait: cmdWait,
      fleet: cmdFleet,
      superseded: cmdSuperseded,
      runners: cmdRunners,
    };

    const fn = table[command];
    if (!fn) {
      process.stdout.write(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }

    if (!config.orgs.length) {
      process.stdout.write("No organisation. Pass --org <name> or add one to runner-queue.config.json.\n");
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`${await fn(config, { json })}\n`);
    return;
  }

  if (!config.orgs.length) {
    process.stdout.write(`No organisation configured.\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const port = Number(flagValue("port", process.env.PORT ?? 7777));
  startServer(config, { port });
}

main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
});
