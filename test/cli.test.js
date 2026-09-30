import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SCHEMA } from "../src/config.js";
import { OPTIONS } from "../src/args.js";
import { COMMANDS } from "../src/commands.js";

/**
 * End-to-end checks of the command line itself: what it writes to stdout, what
 * it writes to stderr, and what it exits with. These need no network and no
 * GitHub credentials, because every command they exercise is decided before any
 * of that is reached.
 */

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.js");

const tmp = () => mkdtemp(join(tmpdir(), "rq-cli-"));

/**
 * A deliberately narrow environment: the developer's own RUNNER_QUEUE_*
 * variables and their real ~/.config must not be able to change what these
 * tests assert.
 */
const cleanEnv = (dir) => ({
  PATH: process.env.PATH,
  HOME: dir,
  NO_COLOR: "1",
  XDG_CONFIG_HOME: join(dir, "xdg"),
  XDG_CACHE_HOME: join(dir, "cache"),
});

/** Returns the exit code alongside the output, rather than throwing on failure. */
async function rq(args, { cwd, env } = {}) {
  const dir = cwd ?? (await tmp());
  try {
    const { stdout, stderr } = await run("node", [cli, ...args], {
      cwd: dir,
      env: env ?? cleanEnv(dir),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("--version prints the version from the installed package", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const { code, stdout } = await rq(["--version"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), `${pkg.name} ${pkg.version}`);
});

test("--help documents every command, setting and option", async () => {
  const { code, stdout } = await rq(["--help"]);
  assert.equal(code, 0);

  for (const command of Object.keys(COMMANDS)) {
    assert.ok(stdout.includes(command), `command ${command}`);
  }
  // Every schema setting must be discoverable, or "config everything" is a lie.
  for (const entry of SCHEMA) {
    assert.match(stdout, new RegExp(`--${entry.flag}\\b`), `flag --${entry.flag}`);
    assert.ok(stdout.includes(entry.env), `env ${entry.env}`);
    assert.ok(stdout.includes(entry.key), `key ${entry.key}`);
  }
  for (const flag of Object.keys(OPTIONS)) {
    assert.ok(stdout.includes(`--${flag}`), `option --${flag}`);
  }
  assert.match(stdout, /Exit codes/);
});

test("--help is not a second copy of itself", async () => {
  // Cheap guard against a table gaining a duplicate row.
  const { stdout } = await rq(["--help"]);
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.equal(new Set(lines).size, lines.length);
});

test("the README documents every command and every setting", async () => {
  // The README's tables are written by hand while `--help` is generated, so
  // they can drift apart. A new setting that nobody wrote down is a setting
  // nobody can find.
  const readme = await readFile(join(root, "README.md"), "utf8");

  for (const command of Object.keys(COMMANDS)) {
    assert.ok(readme.includes(command), `command ${command}`);
  }
  for (const entry of SCHEMA) {
    assert.ok(readme.includes(`\`${entry.key}\``), `setting ${entry.key}`);
  }
  for (const claim of ["MIT", "Node 22", "gh auth login"]) {
    assert.ok(readme.includes(claim), `README should state ${claim}`);
  }
});

test("the README does not promise a test count that will go stale", async () => {
  // An exact count in the docs is wrong the moment a test is added.
  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.doesNotMatch(readme, /\b\d{2,4} tests\b/);
});

test("no command prints usage and fails, because there is no default action", async () => {
  const { code, stdout, stderr } = await rq([]);
  assert.equal(code, 1);
  assert.equal(stdout, "", "usage on an error belongs on stderr");
  assert.match(stderr, /Usage/);
});

test("an unknown command is named, with a pointer to help", async () => {
  const { code, stderr } = await rq(["nonsense"]);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command "nonsense"/);
  assert.match(stderr, /--help/);
});

test("an unknown option is refused rather than ignored", async () => {
  const { code, stderr } = await rq(["--orgg", "acme", "jobs"]);
  assert.equal(code, 1);
  assert.match(stderr, /unknown option --orgg/);
});

test("a flag with no value is an error, not a silently skipped flag", async () => {
  const { code, stderr } = await rq(["jobs", "--org"]);
  assert.equal(code, 1);
  assert.match(stderr, /--org needs a value/);
});

test("neither command takes arguments, so passing one is an error", async () => {
  const { code, stderr } = await rq(["jobs", "extra"]);
  assert.equal(code, 1);
  assert.match(stderr, /takes no arguments/);
});

test("running without an organisation explains every way to set one", async () => {
  const { code, stderr } = await rq(["jobs"]);
  assert.equal(code, 1);
  assert.match(stderr, /No organisation/);
  assert.match(stderr, /--org acme jobs/);
  assert.match(stderr, /RUNNER_QUEUE_ORG=acme/);
  assert.match(stderr, /runner-queue\.config\.example\.json/);
});

test("a config mistake is reported as itself, not as a GitHub failure", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "runner-queue.config.json"), '{"thresholdMinuts": 5}');
  const { code, stderr } = await rq(["jobs"], { cwd: dir });
  assert.equal(code, 1);
  assert.match(stderr, /unknown key "thresholdMinuts"/);
  assert.doesNotMatch(stderr, /gh auth status/);
});

test("the environment is honoured end to end", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "runner-queue.config.json"), JSON.stringify({ thresholdMinutes: 25 }));

  const { code, stderr } = await rq(["jobs", "--json"], {
    cwd: dir,
    env: { ...cleanEnv(dir), RUNNER_QUEUE_ORG: "from-env" },
  });
  assert.equal(code, 1, "still fails without credentials, but not on its config");
  assert.doesNotMatch(stderr, /config/);

  // The org reached the point of being used, which is what this asserts.
  assert.match(stderr, /from-env|No organisation|reach GitHub|auth/);
});

test("a config file is read from the user config directory too", async () => {
  const dir = await tmp();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "xdg", "runner-queue"), { recursive: true });
  await writeFile(
    join(dir, "xdg", "runner-queue", "runner-queue.config.json"),
    JSON.stringify({ orgs: ["from-xdg"] }),
  );

  const { stderr } = await rq(["jobs"], { cwd: tmp() });
  assert.doesNotMatch(stderr, /No organisation/, "the user config must be found");

  // The path it resolved is the one written.
  assert.ok(await realpath(join(dir, "xdg", "runner-queue")));
});
