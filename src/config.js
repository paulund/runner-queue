/**
 * Configuration, in one table.
 *
 * Every setting the tool has is declared once in `SCHEMA`, with its type,
 * default, flag and environment variable. The file, the environment and the
 * command line are then just three ways of filling in the same table, and
 * `--help` is generated from it so the three can never drift apart.
 *
 * Precedence, highest first: command line, environment, config file, defaults.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const APP = "runner-queue";
export const CONFIG_FILENAME = "runner-queue.config.json";

/**
 * `type` is one of list, number, boolean or string. `nullable` allows an
 * explicit null for a string setting. `min`/`max`/`integer` narrow a number
 * setting to something meaningful rather than merely finite.
 */
export const SCHEMA = [
  {
    key: "orgs",
    type: "list",
    default: [],
    flag: "org",
    env: "RUNNER_QUEUE_ORG",
    help: "GitHub organisations to watch",
  },
  {
    key: "thresholdMinutes",
    type: "number",
    default: 10,
    flag: "threshold",
    env: "RUNNER_QUEUE_THRESHOLD_MINUTES",
    help: "minutes before a queued job counts as stuck",
  },
  {
    key: "historyDays",
    type: "number",
    integer: true,
    min: 1,
    default: 30,
    flag: "history-days",
    env: "RUNNER_QUEUE_HISTORY_DAYS",
    help: "days of completed runs to analyse",
  },
  {
    key: "historySample",
    type: "number",
    integer: true,
    min: 1,
    default: 40,
    flag: "history-sample",
    env: "RUNNER_QUEUE_HISTORY_SAMPLE",
    help: "completed runs sampled per repo",
  },
  {
    key: "onlyRepos",
    type: "list",
    default: [],
    flag: "only-repo",
    env: "RUNNER_QUEUE_ONLY_REPOS",
    help: "only these repos (cannot be combined with --ignore-repo)",
  },
  {
    key: "ignoreRepos",
    type: "list",
    default: [],
    flag: "ignore-repo",
    env: "RUNNER_QUEUE_IGNORE_REPOS",
    help: "skip these repos (cannot be combined with --only-repo)",
  },
  {
    key: "includeArchived",
    type: "boolean",
    default: false,
    flag: "archived",
    negFlag: "no-archived",
    env: "RUNNER_QUEUE_INCLUDE_ARCHIVED",
    help: "include archived repositories",
  },
  {
    key: "concurrency",
    type: "number",
    integer: true,
    min: 1,
    default: 8,
    flag: "concurrency",
    env: "RUNNER_QUEUE_CONCURRENCY",
    help: "GitHub requests in flight at once",
  },
  {
    key: "queueRunPages",
    type: "number",
    integer: true,
    min: 1,
    default: 2,
    flag: "queue-pages",
    env: "RUNNER_QUEUE_QUEUE_PAGES",
    help: "pages of queued runs to read per repo (100 each)",
  },
  {
    key: "cacheDir",
    type: "string",
    nullable: true,
    default: null,
    flag: "cache-dir",
    env: "RUNNER_QUEUE_CACHE",
    help: "where history and alert state are cached",
  },
  {
    key: "workDir",
    type: "string",
    nullable: true,
    default: null,
    flag: "work-dir",
    env: "RUNNER_WORK",
    help: "a runner's _work directory, for clean",
  },
  {
    key: "cleanupAgeHours",
    type: "number",
    integer: true,
    min: 1,
    default: 24,
    flag: "cleanup-age-hours",
    env: "RUNNER_QUEUE_CLEANUP_AGE_HOURS",
    help: "how old a checkout has to be before clean will remove it",
  },
  {
    key: "hostReportDir",
    type: "string",
    nullable: true,
    default: null,
    flag: "host-report-dir",
    env: "RUNNER_QUEUE_HOST_REPORT_DIR",
    help: "directory of host reports (written by clean, read by jobs)",
  },
  {
    key: "hostReportMaxAgeMinutes",
    type: "number",
    integer: true,
    min: 1,
    default: 30,
    flag: "host-report-max-age",
    env: "RUNNER_QUEUE_HOST_REPORT_MAX_AGE",
    help: "how old a host report may be before it is ignored",
  },
  {
    key: "hostDiskFreePercent",
    type: "number",
    min: 0,
    max: 100,
    default: 5,
    flag: "host-disk-free",
    env: "RUNNER_QUEUE_HOST_DISK_FREE",
    help: "free disk percent below which a host counts as out of space",
  },
];

const BY_KEY = new Map(SCHEMA.map((entry) => [entry.key, entry]));

/**
 * A configuration mistake rather than a failure of the thing being configured.
 * The distinction matters at the top level: a bad config needs its own message
 * printed verbatim, where a GitHub failure needs translating.
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.kind = "config";
  }
}

const get = (obj, path) =>
  path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

function set(obj, path, value) {
  const [head, ...rest] = path.split(".");
  if (!rest.length) {
    obj[head] = value;
    return;
  }
  obj[head] = { ...(obj[head] ?? {}) };
  set(obj[head], rest.join("."), value);
}

const clone = (value) => (Array.isArray(value) ? [...value] : value);

/** The nested config object that every value starts from. */
export function defaults() {
  const out = {};
  for (const entry of SCHEMA) set(out, entry.key, clone(entry.default));
  return out;
}

/** Turns a file, env or flag value into the type the schema declares. */
function coerce(entry, raw, source) {
  const fail = (expected) =>
    new ConfigError(`config: ${entry.key} must be ${expected} (from ${source})`);

  switch (entry.type) {
    case "list": {
      const items = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw.split(",")
          : null;
      if (!items) throw fail("a list of strings");
      if (items.some((v) => typeof v !== "string")) throw fail("a list of strings");
      return items.map((v) => v.trim()).filter(Boolean);
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw fail("a number");
      if (entry.integer && !Number.isInteger(n)) throw fail("a whole number");
      if (n < (entry.min ?? 0)) {
        throw fail(entry.min === 1 ? "at least 1" : `at least ${entry.min}`);
      }
      if (entry.max !== undefined && n > entry.max) {
        throw fail(`between 0 and ${entry.max}`);
      }
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const text = String(raw).trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(text)) return true;
      if (["false", "0", "no", "off"].includes(text)) return false;
      throw fail("true or false");
    }
    case "string": {
      if (raw === null && entry.nullable) return null;
      if (typeof raw !== "string" || !raw.trim()) {
        throw fail(entry.nullable ? "a non-empty string or null" : "a non-empty string");
      }
      return raw.trim();
    }
    default:
      throw new ConfigError(
        `config: ${entry.key} has an unknown type "${entry.type}"`,
      );
  }
}

/**
 * Where a config file may live, in precedence order. The first one that exists
 * wins; `--config` short-circuits the search.
 */
export function configCandidates({ cwd = process.cwd(), env = process.env } = {}) {
  const list = [];
  if (env.RUNNER_QUEUE_CONFIG) {
    list.push({ source: "RUNNER_QUEUE_CONFIG", path: env.RUNNER_QUEUE_CONFIG });
  }
  list.push({ source: "working directory", path: join(cwd, CONFIG_FILENAME) });
  list.push({
    source: "user config",
    path: join(xdgConfigHome(env), APP, CONFIG_FILENAME),
  });
  return list;
}

function xdgConfigHome(env) {
  return env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/** The cache directory: `--cache-dir`, or the XDG cache home. */
export function cacheDir(config, env = process.env) {
  if (config.cacheDir) return config.cacheDir;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), APP);
}

/** History cache path. `days` is in the name so windows cannot be confused. */
export function cacheFile(config, env = process.env) {
  const orgs = config.orgs.length ? config.orgs.join("-") : "org";
  const slug = orgs.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return join(cacheDir(config, env), `history-${slug || "org"}-${config.historyDays}d.json`);
}

/**
 * What the history cache was built from. A cached sample is only valid for the
 * exact settings that produced it, so this fingerprint is compared on read --
 * otherwise raising `historySample` would silently keep serving the old sample.
 */
export function historyKey(config) {
  return JSON.stringify({
    orgs: [...config.orgs].sort(),
    days: config.historyDays,
    sample: config.historySample,
    onlyRepos: [...config.onlyRepos].sort(),
    ignoreRepos: [...config.ignoreRepos].sort(),
    includeArchived: config.includeArchived,
  });
}

/**
 * The example file, generated from the schema. It lists every setting at its
 * default, so nothing is hidden, and deleting a key is safe -- a missing key
 * falls back to the same default.
 */
export function exampleConfig() {
  const out = {};
  for (const entry of SCHEMA) set(out, entry.key, clone(entry.default));
  return `${JSON.stringify(out, null, 2)}\n`;
}

function applyValue(config, sources, entry, raw, source) {
  set(config, entry.key, coerce(entry, raw, source));
  sources[entry.key] = source;
}

async function readConfigFile(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`config: could not parse ${file}: ${err.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`config: ${file} must contain a JSON object`);
  }

  const config = defaults();
  const sources = Object.fromEntries(SCHEMA.map((e) => [e.key, "default"]));
  const source = `file ${file}`;

  for (const [key, value] of Object.entries(raw)) {
    const direct = BY_KEY.get(key);
    if (direct) {
      applyValue(config, sources, direct, value, source);
      continue;
    }

    const nested = SCHEMA.filter((e) => e.key.startsWith(`${key}.`));
    if (!nested.length) {
      throw new ConfigError(`config: unknown key "${key}" in ${file}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ConfigError(`config: "${key}" in ${file} must be an object`);
    }
    for (const [sub, subValue] of Object.entries(value)) {
      const entry = nested.find((e) => e.key === `${key}.${sub}`);
      if (!entry) {
        throw new ConfigError(`config: unknown key "${key}.${sub}" in ${file}`);
      }
      applyValue(config, sources, entry, subValue, source);
    }
  }

  return { config, sources };
}

/**
 * Resolves every setting from the command line, the environment, a config file
 * and the defaults, in that order of precedence.
 *
 * The option type is written out rather than inferred: TypeScript drops
 * shorthand properties that have no default value from a destructured
 * parameter, so `path` would go missing from the signature.
 *
 * @param {{
 *   path?: string,
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   flags?: Map<string, { value: unknown, label: string }>,
 * }} [options]
 * @returns {Promise<Record<string, any>>} the settings, plus `source` and
 *   `sources` describing where each value came from
 */
export async function loadConfig({
  path,
  cwd = process.cwd(),
  env = process.env,
  flags = new Map(),
} = {}) {
  const candidates = configCandidates({ cwd, env });
  const chosen = path
    ? { source: "--config", path }
    : candidates.find((c) => existsSync(c.path)) ?? null;

  // An explicit path that does not exist is a mistake worth reporting; a
  // searched-for path simply being absent is the normal case. A path named
  // explicitly through the environment counts as explicit, or a typo there
  // would silently fall through to the defaults.
  if (path && !existsSync(path)) {
    throw new ConfigError(`config: no such file: ${path}`);
  }
  if (!path && env.RUNNER_QUEUE_CONFIG && !existsSync(env.RUNNER_QUEUE_CONFIG)) {
    throw new ConfigError(
      `config: RUNNER_QUEUE_CONFIG points at a file that does not exist: ${env.RUNNER_QUEUE_CONFIG}`,
    );
  }

  const fromFile = chosen ? await readConfigFile(chosen.path) : null;
  const config = fromFile ? fromFile.config : defaults();
  const sources = fromFile
    ? fromFile.sources
    : Object.fromEntries(SCHEMA.map((e) => [e.key, "default"]));

  for (const entry of SCHEMA) {
    const raw = env[entry.env];
    if (raw === undefined || raw === "") continue;
    applyValue(config, sources, entry, raw, `env ${entry.env}`);
  }

  for (const entry of SCHEMA) {
    const given = flags.get(entry.flag);
    if (!given) continue;
    applyValue(config, sources, entry, given.value, `flag ${given.label}`);
  }

  if (config.onlyRepos.length && config.ignoreRepos.length) {
    throw new ConfigError(
      "config: use onlyRepos or ignoreRepos, not both (from file, environment or flags)",
    );
  }

  // `source` and `sources` are metadata about how this config was assembled,
  // not settings, and are never written back to a file.
  config.source = chosen ? chosen.path : "defaults";
  config.sources = sources;
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

/** Reads one schema value, for code that needs a setting by name. */
export function setting(config, key) {
  return get(config, key);
}

