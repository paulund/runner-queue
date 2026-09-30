/**
 * Failure handling, shared by every command.
 *
 * `gh` writes its errors for a human reading a terminal: they carry a support
 * request id, a user id and a paragraph of advice. None of that belongs in a
 * script's stdout, and none of it says what to do next. Everything here turns
 * one of those into a single line a person can act on.
 */

/**
 * Exit codes are part of the interface, not an implementation detail: this tool
 * is meant to be run from cron and from CI, and those callers need to tell
 * "it failed" apart from "it worked and found something wrong".
 */
export const EXIT = {
  ok: 0,
  error: 1,
  attention: 2,
};

export const EXIT_MEANINGS = {
  [EXIT.ok]: "nothing needs your attention",
  [EXIT.error]: "the command could not do its job",
  [EXIT.attention]: "the command worked and found something to act on",
};

/**
 * The GitHub hostname to talk to. Read from the environment rather than
 * hardcoded, because `gh` does the same and a GitHub Enterprise user should not
 * have to be told to use github.com.
 */
export function hostname(env = process.env) {
  return env.GH_HOST || env.GITHUB_HOST || "github.com";
}

/** The command that grants runner visibility, for the current host. */
export function scopeFix(env = process.env) {
  return `gh auth refresh -h ${hostname(env)} -s admin:org`;
}

/**
 * Turns a `gh` failure into one actionable line, with no host-specific guesswork.
 *
 * Only a failed call to `gh` is translated. Anything else is a bug in this tool,
 * and reporting it as "could not reach GitHub" would hide a defect behind a
 * network problem -- which is exactly the sort of misdirection this module
 * exists to remove.
 */
export function friendlyError(err, env = process.env) {
  const isGhCall = err?.stderr !== undefined || err?.code === "ENOENT";
  if (!isGhCall) return String(err?.message ?? err);

  const text = String(err.stderr ?? err.message ?? "");

  // Checked before the plain rate limit case: GitHub phrases this as
  // "secondary rate limit", and the fix is different -- back off the burst
  // rather than wait for the hourly window to reset.
  if (/secondary rate limit|abuse detection/i.test(text)) {
    return "GitHub throttled the request burst. Lower --concurrency, or raise the window it measures over, and try again.";
  }
  if (/rate limit/i.test(text)) {
    return "GitHub's API rate limit was reached. Wait for it to reset, or lower --history-sample to ask for less.";
  }
  if (/admin:org|org admin/i.test(text)) {
    return `Runner capacity is hidden without the admin:org scope: ${scopeFix(env)}`;
  }
  if (/bad credentials|\b401\b/i.test(text)) {
    return `GitHub rejected the credentials. Run: gh auth login -h ${hostname(env)}`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|offline/i.test(text)) {
    return `Could not reach ${hostname(env)}. Check the network, then run: gh auth status`;
  }
  return `Could not reach GitHub. Run: gh auth status`;
}
