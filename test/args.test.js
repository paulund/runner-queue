import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/args.js";

test("a flag before or after the command is the same command", () => {
  const before = parseArgs(["--org", "acme", "jobs"]);
  const after = parseArgs(["jobs", "--org", "acme"]);

  assert.equal(before.command, "jobs");
  assert.equal(after.command, "jobs");
  assert.deepEqual(before.flags.get("org").value, ["acme"]);
  assert.deepEqual(after.flags.get("org").value, ["acme"]);
});

test("a list flag can be repeated and each value is kept", () => {
  const parsed = parseArgs(["--ignore-repo", "docs", "--ignore-repo", "website,legacy"]);
  assert.deepEqual(parsed.flags.get("ignore-repo").value, ["docs", "website", "legacy"]);
});

test("--flag=value is the same as --flag value", () => {
  const parsed = parseArgs(["--org=acme", "--threshold=30", "jobs"]);
  assert.deepEqual(parsed.flags.get("org").value, ["acme"]);
  assert.equal(parsed.flags.get("threshold").value, "30");
  assert.equal(parsed.command, "jobs");
});

test("a flag that needs a value and does not have one is an error, not a silent skip", () => {
  const parsed = parseArgs(["jobs", "--org"]);
  assert.deepEqual(parsed.errors, ["--org needs a value"]);
});

test("a value that looks like another flag is not swallowed as a value", () => {
  const parsed = parseArgs(["--org", "--json", "jobs"]);
  assert.deepEqual(parsed.errors, ["--org needs a value"]);
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.command, "jobs");
});

test("a negative number is passed through so the schema can explain itself", () => {
  // `--threshold -1` should say "must be a non-negative number", not "needs a
  // value", because the first is the actual mistake.
  const parsed = parseArgs(["--threshold", "-1"]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.flags.get("threshold").value, "-1");
});

test("an unknown option is reported instead of ignored", () => {
  const parsed = parseArgs(["jobs", "--orgg", "acme"]);
  assert.deepEqual(parsed.errors, ["unknown option --orgg"]);
});

test("the first bare word is the command and the rest are its arguments", () => {
  const parsed = parseArgs(["config", "init", "./my.config.json"]);
  assert.equal(parsed.command, "config");
  assert.deepEqual(parsed.positionals, ["init", "./my.config.json"]);
});

test("a non-option argument is not mistaken for a command", () => {
  const parsed = parseArgs(["cancel", "123456"]);
  assert.equal(parsed.command, "cancel");
  assert.deepEqual(parsed.positionals, ["123456"]);
});

test("everything after -- is an argument, whatever it looks like", () => {
  const parsed = parseArgs(["config", "init", "--", "--weird-name.json"]);
  assert.deepEqual(parsed.positionals, ["init", "--weird-name.json"]);
});

test("-h and -v are short forms of --help and --version", () => {
  assert.equal(parseArgs(["-h"]).options.help, true);
  assert.equal(parseArgs(["--help"]).options.help, true);
  assert.equal(parseArgs(["-v"]).options.version, true);
  assert.equal(parseArgs(["--version"]).options.version, true);
});



test("no arguments at all is not an error on its own", () => {
  // The caller decides what an empty command line means, so the parser just
  // reports that there was nothing there.
  const parsed = parseArgs([]);
  assert.equal(parsed.command, null);
  assert.deepEqual(parsed.positionals, []);
  assert.deepEqual(parsed.errors, []);
});
