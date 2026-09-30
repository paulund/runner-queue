/**
 * Command line parsing, driven by the config schema.
 *
 * Every config setting is a flag because the schema says so -- there is no
 * second list of flags to keep in step with the settings table. The switches
 * that are not settings (`--json`, `--exit-zero`, …) are declared separately.
 *
 * Both tables are exported with a `type`, a `help`, and a `name` -- the
 * spelling the code reads it under, which is not always the flag's.
 */
import { SCHEMA } from "./config.js";

/**
 * The switches that are not settings. `type: "value"` takes an argument and
 * `type: "boolean"` does not; `name` is the spelling the code reads the option
 * under, which is not always the flag's. Every one of these applies to every
 * command.
 */
export const OPTIONS = {
  config: { type: "value", name: "config", help: "config file to use" },
  json: { type: "boolean", name: "json", help: "machine-readable output" },
  "exit-zero": {
    type: "boolean",
  
    name: "exitZero",
    help: "always exit 0, even when something needs attention",
  },
  colour: {
    type: "boolean",
  
    name: "colour",
    help: "force coloured output",
  },
  "no-colour": {
    type: "boolean",
  
    name: "noColour",
    help: "plain, uncoloured output",
  },
  help: { type: "boolean", name: "help", help: "this text" },
  version: { type: "boolean", name: "version", help: "print the version" },
};


/** Resolves `--flag`, `--no-flag` and `--flag=value` against the schema. */
function buildFlagIndex(schema) {
  const index = new Map();
  for (const entry of schema) {
    index.set(entry.flag, { entry, negated: false });
    if (entry.negFlag) index.set(entry.negFlag, { entry, negated: true });
  }
  return index;
}

const splitList = (value) =>
  String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * Parses argv into a command, its positional arguments, the settings chosen by
 * flags, and the non-config options. Flags may appear on either side of the
 * command name, which is what makes `runner-queue --org acme jobs` and
 * `runner-queue jobs --org acme` the same command.
 */
export function parseArgs(argv = [], { schema = SCHEMA } = {}) {
  const configFlags = buildFlagIndex(schema);
  const flags = new Map();
  const options = {};
  const positionals = [];
  const errors = [];
  let command = null;
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (passthrough) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "-v") {
      options.version = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      if (command === null) command = arg;
      else positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    const option = OPTIONS[name];
    if (option) {
      const target = option.name;
      if (option.type === "value") {
        if (inline !== undefined) {
          options[target] = inline;
        } else {
          // A value that looks like another flag is a missing argument, not a
          // value. Anything else, including `-1`, is taken as the value so the
          // schema can reject it with a useful message.
          const next = argv[i + 1];
          if (next === undefined || next.startsWith("--")) {
            errors.push(`--${name} needs a value`);
            continue;
          }
          options[target] = next;
          i++;
        }
      } else {
        options[target] =
          inline === undefined ? true : inline !== "false" && inline !== "0";
      }
      continue;
    }

    const match = configFlags.get(name);
    if (!match) {
      errors.push(`unknown option --${name}`);
      continue;
    }
    const { entry, negated } = match;
    const label = `--${name}`;

    if (entry.type === "boolean") {
      const value =
        inline === undefined ? !negated : inline !== "false" && inline !== "0";
      flags.set(entry.flag, { value, label });
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        errors.push(`--${name} needs a value`);
        continue;
      }
      value = next;
      i++;
    }

    if (entry.type === "list") {
      const existing = flags.get(entry.flag);
      const list = existing ? [...existing.value] : [];
      list.push(...splitList(value));
      flags.set(entry.flag, { value: list, label });
    } else {
      flags.set(entry.flag, { value, label });
    }
  }

  return { command, positionals, flags, options, errors };
}

