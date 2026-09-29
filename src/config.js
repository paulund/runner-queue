import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  orgs: [],
  thresholdMinutes: 10,
  historyDays: 30,
  historySample: 40,
  ignoreRepos: [],
  onlyRepos: [],
  includeArchived: false,
  defaultBranch: "main",
  fleet: {
    // A runner sitting idle more than this fraction of sampled hours is not
    // the bottleneck; adding capacity only helps when they are saturated.
    idleCeiling: 0.15,
    targetUtilisation: 0.8,
  },
  alerts: {
    enabled: false,
    // Sustained means "still bad after this long", to avoid paging on a
    // momentary spike every time someone pushes five branches at once.
    sustainedMinutes: 15,
    webhookUrl: null,
    cooldownMinutes: 60,
  },
  write: {
    // Actions that change GitHub state stay off unless explicitly enabled.
    allowCancel: false,
    allowRerun: false,
  },
};

const NUMERIC = new Set([
  "thresholdMinutes",
  "historyDays",
  "historySample",
]);

function coerce(key, value) {
  if (NUMERIC.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`config: ${key} must be a non-negative number`);
    }
    return n;
  }
  if (typeof DEFAULTS[key] === "boolean" && typeof value !== "boolean") {
    throw new Error(`config: ${key} must be true or false`);
  }
  return value;
}

/**
 * Loads config from `--config path`, else `runner-queue.config.json` in the
 * working directory, else sensible defaults. Unknown keys are rejected so a
 * typo surfaces immediately rather than silently doing nothing.
 */
export async function loadConfig({ path, cwd = process.cwd() } = {}) {
  const file =
    path ??
    (existsSync(join(cwd, "runner-queue.config.json"))
      ? join(cwd, "runner-queue.config.json")
      : null);

  // An explicit --config that does not exist is a mistake worth reporting,
  // but the auto-discovered path simply not existing is the normal case.
  if (!file) return { ...DEFAULTS, source: "defaults" };
  if (!existsSync(file)) {
    throw new Error(`config: no such file: ${file}`);
  }

  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`config: could not parse ${file}: ${err.message}`);
  }

  const config = { ...DEFAULTS, source: file };
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) {
      throw new Error(`config: unknown key "${key}" in ${file}`);
    }
    if (key === "fleet" || key === "alerts" || key === "write") {
      config[key] = { ...DEFAULTS[key], ...value };
      for (const [sub, subValue] of Object.entries(value ?? {})) {
        if (!(sub in DEFAULTS[key])) {
          throw new Error(`config: unknown key "${key}.${sub}" in ${file}`);
        }
        if (typeof DEFAULTS[key][sub] === "number") {
          const n = Number(subValue);
          if (!Number.isFinite(n) || n < 0) {
            throw new Error(`config: ${key}.${sub} must be a non-negative number`);
          }
          config[key][sub] = n;
        } else {
          config[key][sub] = subValue;
        }
      }
      continue;
    }
    config[key] = coerce(key, value);
  }

  if (config.onlyRepos.length && config.ignoreRepos.length) {
    throw new Error("config: use onlyRepos or ignoreRepos, not both");
  }

  return config;
}

/** Applies the ignore/include filters to a repo list. */
export function filterRepos(repos, config) {
  const only = new Set(config.onlyRepos);
  const ignore = new Set(config.ignoreRepos);
  return repos.filter((r) => {
    if (only.size) return only.has(r.name) || only.has(r.full_name);
    return !ignore.has(r.name) && !ignore.has(r.full_name);
  });
}

export { DEFAULTS };
