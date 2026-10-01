import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA,
  cacheFile,
  configCandidates,
  exampleConfig,
  filterRepos,
  historyKey,
  loadConfig,
  setting,
} from "../src/config.js";

const tmp = () => mkdtemp(join(tmpdir(), "rq-config-"));
const writeConfig = async (dir, body) => {
  const file = join(dir, "runner-queue.config.json");
  await writeFile(file, JSON.stringify(body));
  return file;
};

/**
 * An empty environment, so a developer's real `~/.config/runner-queue/` cannot
 * decide what a test asserts.
 *
 * `XDG_CONFIG_HOME` is the lever that works here, and it is worth knowing why.
 * `xdgConfigHome` falls back to `homedir()` when it is unset, and `homedir()`
 * reads the real process environment -- not the `env` object passed to
 * `loadConfig`. So setting `HOME` in that object does nothing at all, and
 * `env: {}` is not isolation, it is a request for the actual home directory.
 * Pointing `XDG_CONFIG_HOME` at a fresh temporary directory is the one override
 * that is read from the object that was passed.
 */
const noHome = async () => ({ XDG_CONFIG_HOME: await tmp() });

test("an unknown key is rejected rather than ignored", async () => {
  const file = await writeConfig(await tmp(), { thresholdMinuts: 5 });
  await assert.rejects(() => loadConfig({ path: file }), /unknown key "thresholdMinuts"/);
});

test("onlyRepos and ignoreRepos cannot both be set", async () => {
  const file = await writeConfig(await tmp(), { onlyRepos: ["a"], ignoreRepos: ["b"] });
  await assert.rejects(() => loadConfig({ path: file }), /not both/);
});

test("a broken config file is reported as a config problem, not a GitHub failure", async () => {
  const file = join(await tmp(), "broken.json");
  await writeFile(file, "{ not json");
  await assert.rejects(
    () => loadConfig({ path: file }),
    (err) => err.kind === "config" && /could not parse/.test(err.message),
  );
});

test("an explicit --config that is missing is reported, not ignored", async () => {
  const dir = await tmp();
  await assert.rejects(() => loadConfig({ path: join(dir, "nope.json") }), /no such file/);
});

test("RUNNER_QUEUE_CONFIG pointing at a missing file is an error, not a fallback", async () => {
  // Otherwise a typo in the environment silently runs with different settings
  // than the person believes they set.
  await assert.rejects(
    async () =>
      loadConfig({
        cwd: await tmp(),
        env: { RUNNER_QUEUE_CONFIG: "/nonexistent/runner-queue.json" },
        flags: new Map(),
      }),
    /RUNNER_QUEUE_CONFIG points at a file that does not exist/,
  );
});

test("defaults apply when no config file exists", async () => {
  const config = await loadConfig({ cwd: await tmp(), env: await noHome(), flags: new Map() });
  assert.equal(config.source, "defaults");
  assert.equal(config.thresholdMinutes, 10);
  assert.equal(config.includeArchived, false);
});

test("a config file in the working directory is found automatically", async () => {
  const dir = await tmp();
  await writeConfig(dir, { orgs: ["acme"], thresholdMinutes: 25 });
  const config = await loadConfig({ cwd: dir, env: {}, flags: new Map() });
  assert.deepEqual(config.orgs, ["acme"]);
  assert.equal(config.thresholdMinutes, 25);
});

test("a config file in the user config directory is found when the cwd has none", async () => {
  const dir = await tmp();
  const home = await tmp();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, "runner-queue"), { recursive: true });
  await writeFile(
    join(home, "runner-queue", "runner-queue.config.json"),
    JSON.stringify({ orgs: ["from-xdg"] }),
  );

  const config = await loadConfig({
    cwd: dir,
    env: { XDG_CONFIG_HOME: home },
    flags: new Map(),
  });
  assert.deepEqual(config.orgs, ["from-xdg"]);
});

test("the working directory wins over the user config directory", async () => {
  const local = await tmp();
  const home = await tmp();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(home, "runner-queue"), { recursive: true });
  await writeFile(
    join(home, "runner-queue", "runner-queue.config.json"),
    JSON.stringify({ orgs: ["from-xdg"] }),
  );
  await writeConfig(local, { orgs: ["from-cwd"] });

  const config = await loadConfig({
    cwd: local,
    env: { XDG_CONFIG_HOME: home },
    flags: new Map(),
  });
  assert.deepEqual(config.orgs, ["from-cwd"]);
});

test("config candidates list every place a file could live, in order", () => {
  const candidates = configCandidates({
    cwd: "/work",
    env: { XDG_CONFIG_HOME: "/xdg", RUNNER_QUEUE_CONFIG: "/explicit.json" },
  });
  assert.deepEqual(
    candidates.map((c) => c.path),
    [
      "/explicit.json",
      "/work/runner-queue.config.json",
      "/xdg/runner-queue/runner-queue.config.json",
    ],
  );
});

test("precedence runs flags, then environment, then file, then defaults", async () => {
  const dir = await tmp();
  const file = await writeConfig(dir, { thresholdMinutes: 20, historyDays: 40 });

  const config = await loadConfig({
    path: file,
    env: { RUNNER_QUEUE_THRESHOLD_MINUTES: "50", RUNNER_QUEUE_HISTORY_DAYS: "60" },
    flags: new Map([["threshold", { value: "99", label: "--threshold" }]]),
  });

  assert.equal(config.thresholdMinutes, 99, "flag beats env and file");
  assert.equal(config.historyDays, 60, "env beats file");
  assert.equal(config.concurrency, 8, "unset means default");
});

test("each setting records where its value came from", async () => {
  const dir = await tmp();
  const file = await writeConfig(dir, { thresholdMinutes: 20 });
  const config = await loadConfig({
    path: file,
    env: { RUNNER_QUEUE_HISTORY_DAYS: "7" },
    flags: new Map([["org", { value: ["acme"], label: "--org" }]]),
  });

  assert.match(config.sources.orgs, /^flag --org$/);
  assert.match(config.sources.historyDays, /^env RUNNER_QUEUE_HISTORY_DAYS$/);
  assert.match(config.sources.thresholdMinutes, /^file /);
  assert.equal(config.sources.concurrency, "default");
});

test("environment variables accept the shapes a shell can express", async () => {
  const config = await loadConfig({
    cwd: await tmp(),
    env: {
      RUNNER_QUEUE_ORG: "acme, other",
      RUNNER_QUEUE_THRESHOLD_MINUTES: "2.5",
      RUNNER_QUEUE_INCLUDE_ARCHIVED: "yes",
    },
    flags: new Map(),
  });

  assert.deepEqual(config.orgs, ["acme", "other"]);
  assert.equal(config.thresholdMinutes, 2.5);
  assert.equal(config.includeArchived, true);
});

test("a value that cannot be what it claims to be is rejected, naming its source", async () => {
  await assert.rejects(
    async () =>
      loadConfig({
        cwd: await tmp(),
        env: { RUNNER_QUEUE_CONCURRENCY: "lots" },
        flags: new Map(),
      }),
    (err) =>
      err.kind === "config" &&
      /concurrency must be a number \(from env RUNNER_QUEUE_CONCURRENCY\)/.test(err.message),
  );
});

test("a number setting that only accepts whole numbers says so", async () => {
  await assert.rejects(
    async () =>
      loadConfig({
        cwd: await tmp(),
        env: { RUNNER_QUEUE_CONCURRENCY: "2.5" },
        flags: new Map(),
      }),
    /concurrency must be a whole number/,
  );
  await assert.rejects(
    async () =>
      loadConfig({
        cwd: await tmp(),
        env: { RUNNER_QUEUE_CONCURRENCY: "0" },
        flags: new Map(),
      }),
    /concurrency must be at least 1/,
  );
});

test("a boolean given something that is not a boolean is rejected", async () => {
  await assert.rejects(
    async () =>
      loadConfig({
        cwd: await tmp(),
        env: { RUNNER_QUEUE_INCLUDE_ARCHIVED: "perhaps" },
        flags: new Map(),
      }),
    /includeArchived must be true or false/,
  );
});

test("an empty environment variable is unset, not a value", async () => {
  const config = await loadConfig({
    cwd: await tmp(),
    env: { ...(await noHome()), RUNNER_QUEUE_ORG: "", RUNNER_QUEUE_THRESHOLD_MINUTES: "" },
    flags: new Map(),
  });
  assert.deepEqual(config.orgs, []);
  assert.equal(config.thresholdMinutes, 10);
});

test("includeArchived is a real setting, not a key that does nothing", async () => {
  const config = await loadConfig({
    cwd: await tmp(),
    env: {},
    flags: new Map([["archived", { value: true, label: "--archived" }]]),
  });
  assert.equal(config.includeArchived, true);
});

test("the example config lists every setting and is a valid config", async () => {
  const file = join(await tmp(), "example.json");
  await writeFile(file, exampleConfig());

  const config = await loadConfig({ path: file, env: {}, flags: new Map() });
  for (const entry of SCHEMA) {
    assert.deepEqual(setting(config, entry.key), entry.default, entry.key);
  }
});

test("the committed example config matches what the schema generates", async () => {
  // Guards against the documented example drifting away from the settings.
  const committed = await readFile(
    new URL("../runner-queue.config.example.json", import.meta.url),
    "utf8",
  );
  assert.equal(committed, exampleConfig());
});

test("the cache path is namespaced by org and window", async () => {
  const base = await loadConfig({ cwd: await tmp(), env: {}, flags: new Map() });
  const one = cacheFile({ ...base, orgs: ["acme"], historyDays: 30 });
  const other = cacheFile({ ...base, orgs: ["other"], historyDays: 30 });
  const wider = cacheFile({ ...base, orgs: ["acme"], historyDays: 90 });

  assert.match(one, /history-acme-30d\.json$/);
  assert.notEqual(one, other);
  assert.notEqual(one, wider);
});

test("--cache-dir overrides where the cache lives", async () => {
  const config = await loadConfig({
    cwd: await tmp(),
    env: {},
    flags: new Map([["cache-dir", { value: "/tmp/somewhere", label: "--cache-dir" }]]),
  });
  assert.match(cacheFile(config), /^\/tmp\/somewhere\//);
});

test("the history cache key changes when a setting that shaped it changes", async () => {
  const base = await loadConfig({ cwd: await tmp(), env: {}, flags: new Map() });
  const baseKey = historyKey(base);

  for (const patch of [
    { historySample: 100 },
    { historyDays: 7 },
    { includeArchived: true },
    { ignoreRepos: ["x"] },
    { orgs: ["acme"] },
  ]) {
    assert.notEqual(historyKey({ ...base, ...patch }), baseKey, JSON.stringify(patch));
  }
  assert.equal(historyKey({ ...base, historySample: 40 }), baseKey, "same settings, same key");
});

test("filterRepos honours onlyRepos and ignoreRepos", () => {
  const repos = [
    { name: "api", full_name: "acme/api" },
    { name: "web", full_name: "acme/web" },
    { name: "docs", full_name: "acme/docs" },
  ];
  assert.deepEqual(
    filterRepos(repos, { onlyRepos: ["api"], ignoreRepos: [] }).map((r) => r.name),
    ["api"],
  );
  assert.deepEqual(
    filterRepos(repos, { onlyRepos: [], ignoreRepos: ["docs"] }).map((r) => r.name),
    ["api", "web"],
  );
  assert.deepEqual(
    filterRepos(repos, { onlyRepos: ["acme/web"], ignoreRepos: [] }).map((r) => r.name),
    ["web"],
    "a full name works as well as a bare name",
  );
});
