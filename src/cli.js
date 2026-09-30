#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { APP, SCHEMA, loadConfig } from "./config.js";
import { OPTIONS, parseArgs } from "./args.js";
import { COMMANDS } from "./commands.js";
import { EXIT, EXIT_MEANINGS, friendlyError, scopeFix } from "./errors.js";
import { makeStyler, table } from "./format.js";

/**
 * The entry point: parse, resolve configuration, dispatch, print.
 *
 * All the behaviour lives in `commands.js`; this file is only responsible for
 * turning a command line into a resolved config plus a command call, and for
 * deciding what to write to stdout versus stderr.
 */

/** Read from the installed package, so a global install reports the same version. */
async function readPackage() {
  try {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    return JSON.parse(raw);
  } catch {
    return { name: APP, version: "unknown" };
  }
}

const repoUrl = (pkg) => {
  const url = pkg.homepage ?? pkg.repository?.url ?? "";
  return String(url).replace(/^git\+/, "").replace(/\.git$/, "");
};

function helpText(pkg) {
  const docs = repoUrl(pkg);
  const fix = scopeFix();

  const commands = Object.entries(COMMANDS).map(([cmd, spec]) => [
    `${cmd}${spec.args ? ` ${spec.args}` : ""}`,
    spec.summary,
  ]);

  const settings = SCHEMA.map((entry) => [
    `--${entry.flag}${entry.negFlag ? ` / --${entry.negFlag}` : ""}`,
    entry.key,
    entry.env,
  ]);

  const optionRows = (flag, spec) => [
    `--${flag}${spec.type === "value" ? " <value>" : ""}`,
    spec.help,
  ];

  const options = Object.entries(OPTIONS).map(([flag, spec]) => optionRows(flag, spec));
  options.push(["-h, --help", "this text"], ["-v, --version", "print the version"]);

  // Any command that takes its own options says so here, rather than leaving
  // them to be discovered by typing them.
  const perCommand = Object.entries(COMMANDS)
    .filter(([, spec]) => spec.accepts?.length)
    .map(([name, spec]) => [
      name,
      Object.entries(OPTIONS)
        .filter(([flag]) => spec.accepts.includes(flag))
        .map(([flag, opt]) => optionRows(flag, opt)),
    ]);

  const block = (headers, rows, indent = 2) =>
    table(headers, rows)
      .map((line) => `${" ".repeat(indent)}${line}`)
      .join("\n");

  return `${pkg.name} ${pkg.version} — see what your GitHub self-hosted runner queue is doing, and why.

Usage
  runner-queue <command> [options]

Commands
${block(["command", "what it does"], commands)}

Settings
  Every setting can be given as a flag, an environment variable or a config key.
  Precedence, highest first: flag, environment, config file, default.

${block(["flag", "config key", "environment"], settings)}

Options
${block(["option", "what it does"], options)}
${perCommand
  .map(([name, rows]) => `\n  only for \`${name}\`\n${block(null, rows, 4)}`)
  .join("\n")}

Exit codes
${[0, 1, 2].map((code) => `  ${code}  ${EXIT_MEANINGS[code]}`).join("\n")}

Setup
  gh auth login
  ${fix}   # to see runner capacity

  Runner capacity is hidden without that scope. Everything still runs, but the
  cause of a queued job becomes "unknown" rather than a guess.${
    docs
      ? `

Docs
  ${docs}`
      : ""
  }
`;
}

const out = (text) => process.stdout.write(`${text}\n`);
const err = (text) => process.stderr.write(`${text}\n`);

async function main(argv) {
  const pkg = await readPackage();
  const parsed = parseArgs(argv);

  if (parsed.options.version) {
    out(`${pkg.name} ${pkg.version}`);
    return EXIT.ok;
  }
  if (parsed.options.help) {
    out(helpText(pkg));
    return EXIT.ok;
  }
  if (parsed.errors.length) {
    err(`${parsed.errors.join("\n")}\n\nRun \`runner-queue --help\` for the list of options.`);
    return EXIT.error;
  }
  if (!parsed.command) {
    // There is no default action any more: running the tool with nothing to do
    // is a usage error, not an invitation to start a server.
    err(`${helpText(pkg)}`);
    return EXIT.error;
  }

  const spec = COMMANDS[parsed.command];
  if (!spec) {
    err(
      `Unknown command "${parsed.command}".\n\nRun \`runner-queue --help\` for the list of commands.`,
    );
    return EXIT.error;
  }


  const min = spec.args ? 1 : 0;
  const max = spec.max ?? min;
  if (parsed.positionals.length < min) {
    err(
      `\`${parsed.command}\` needs ${spec.args ?? "an argument"}.\n\nUsage: runner-queue ${parsed.command}${
        spec.args ? ` ${spec.args}` : ""
      }`,
    );
    return EXIT.error;
  }
  if (parsed.positionals.length > max) {
    err(
      `\`${parsed.command}\` takes ${
        max === 1 ? "one argument" : max === 0 ? "no arguments" : `at most ${max} arguments`
      }; got ${parsed.positionals.length}.`,
    );
    return EXIT.error;
  }

  const config = await loadConfig({ path: parsed.options.config, flags: parsed.flags });

  if (!config.orgs.length) {
    err(
      [
        "No organisation configured.",
        "",
        "  runner-queue --org acme jobs # pass one for this run",
        "  RUNNER_QUEUE_ORG=acme jobs   # or set it in the environment",
        "",
        "  For a persistent setting, copy runner-queue.config.example.json to",
        "  runner-queue.config.json and set \"orgs\". See the README.",
      ].join("\n"),
    );
    return EXIT.error;
  }

  const style = makeStyler({
    force: parsed.options.json
      ? false
      : parsed.options.noColour
        ? false
        : parsed.options.colour
          ? true
          : undefined,
  });

  const result = await spec.run(config, {
    ...parsed.options,
    positionals: parsed.positionals,
    style,
  });

  out(result.out);
  return parsed.options.exitZero ? EXIT.ok : result.code;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((caught) => {
    // A configuration mistake is already a sentence for a human; a `gh` failure
    // needs translating; anything else is a bug in this tool and is reported as
    // itself rather than dressed up as something it is not.
    const message =
      caught?.kind === "config" ? caught.message : friendlyError(caught);
    err(`${APP}: ${message}`);
    process.exitCode = EXIT.error;
  });
