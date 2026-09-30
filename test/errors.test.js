import test from "node:test";
import assert from "node:assert/strict";
import { EXIT, EXIT_MEANINGS, friendlyError, hostname, scopeFix } from "../src/errors.js";

const ghFailure = (stderr) => Object.assign(new Error("Command failed"), { stderr });

test("a rate-limited GitHub call surfaces an actionable message, not gh stderr", () => {
  // The raw error contains a support request id and a user id, neither of which
  // a script can use and neither of which says what to do.
  const message = friendlyError(
    ghFailure("gh: API rate limit exceeded for user ID 1. request ID ABC:123 timestamp 2026-01-01"),
  );
  assert.match(message, /rate limit/i);
  assert.doesNotMatch(message, /request ID/);
  assert.doesNotMatch(message, /user ID 1/);
  assert.match(message, /--history-sample/, "it should say how to ask for less");
});

test("a secondary rate limit is told apart from the hourly one", () => {
  // They look similar in the raw text and need opposite responses: back off the
  // burst, versus wait for the window to reset.
  const message = friendlyError(ghFailure("gh: You have exceeded a secondary rate limit"));
  assert.match(message, /--concurrency/);
  assert.doesNotMatch(message, /reset/);
});

test("a missing admin:org scope is reported with the command to fix it", () => {
  const message = friendlyError(
    ghFailure('This API operation needs the "admin:org" scope.'),
  );
  assert.match(message, /gh auth refresh/);
});

test("bad credentials are told how to fix themselves", () => {
  const message = friendlyError(ghFailure("gh: Bad credentials (HTTP 401)"));
  assert.match(message, /gh auth login/);
});

test("a network failure names the host it could not reach", () => {
  const message = friendlyError(ghFailure("getaddrinfo ENOTFOUND api.github.com"));
  assert.match(message, /github\.com/);
  assert.match(message, /gh auth status/);
});

test("an unrecognised failure still says something useful", () => {
  const message = friendlyError(ghFailure("something nobody has seen before"));
  assert.match(message, /gh auth status/);
});

test("the hostname follows gh, so GitHub Enterprise users are not misled", () => {
  assert.equal(hostname({}), "github.com");
  assert.equal(hostname({ GH_HOST: "ghe.example.com" }), "ghe.example.com");
  assert.match(
    scopeFix({ GH_HOST: "ghe.example.com" }),
    /gh auth refresh -h ghe\.example\.com -s admin:org/,
  );
});

test("every exit code has a meaning, because scripts branch on them", () => {
  for (const code of Object.values(EXIT)) {
    assert.equal(typeof EXIT_MEANINGS[code], "string", `exit ${code}`);
  }
  assert.equal(EXIT.ok, 0);
  assert.equal(EXIT.error, 1);
  assert.equal(EXIT.attention, 2);
});
