# runner-queue

See what your GitHub self-hosted runner queue is doing, and why.

GitHub shows you a "Queued jobs" panel, but it does not tell you *why* a job
has been sitting there for six hours, how much of your team's day that has
cost, or whether the answer is more runners or a missing label. This tool
answers those questions, from the same public API the Actions tab uses.

- **Live dashboard** — the queue, ordered by longest wait, with a plain-English
  cause for each job.
- **Analytics** — wait-time percentiles, time-to-green, and job-hours lost to
  queueing, so the cost of a slow queue is a number you can argue with.
- **Workflow linting** — finds the configurations that *cause* queues that
  never drain, before they reach production.
- **Fleet sizing** — recommends adding runners only when measurement shows
  saturation, and tells you when the real problem is labels or concurrency.
- **CLI** — the same engine in text form, with `--json` for agents and scripts.

## Install

No dependencies. Clone and run.

```sh
git clone https://github.com/paulund/runner-queue
cd runner-queue
node src/cli.js --org YourOrg
```

Requires the [GitHub CLI](https://cli.github.com). This tool shells out to
`gh api` rather than managing a token, so your credentials stay in your
keychain and never pass through the browser or this process.

```sh
gh auth login
```

### Seeing runner capacity

Listing runners is an organisation-admin operation, so it needs an extra
scope:

```sh
gh auth refresh -h github.com -s admin:org
```

Without it the tool still shows the queue, and says plainly that capacity is
unknown rather than guessing at a cause. If you are not an org admin, the
queue and analytics still work.

## CLI

```sh
runner-queue                     # start the dashboard on :7777
runner-queue why                 # what is queued, and why it is stuck
runner-queue wait                # wait-time analytics
runner-queue fleet               # how many runners you actually need
runner-queue superseded          # queued runs a newer run has made pointless
runner-queue runners             # runner status and labels
```

Add `--json` to any command for machine-readable output:

```sh
runner-queue why --org YourOrg --json | jq '.jobs[0] | {repo, waitS, cause}'
```

Flags work on either side of the command name, so `runner-queue --org X why`
and `runner-queue why --org X` are equivalent.

## How the numbers are computed

**Wait time** comes from job timestamps: `started_at - created_at` for jobs
that actually started. Run-level `run_started_at` is not used, because GitHub
sets it equal to `created_at` even for runs that never started, so it reports
a wait of zero for jobs that have been queued for hours.

**Time-to-green** is run creation to run completion, which is the delay a
developer actually feels after pushing. The tool reports what share of that
is queue wait, since that is the part you can fix.

**Job-hours blocked** sums the wait of every job. Jobs that wait in parallel
each count, so read it as "job-hours of delay", not elapsed wall-clock hours.

Every percentile is shown with its sample size. A p90 computed from five jobs
is not a measurement, and the tool does not pretend otherwise.

**Percentiles are noisy on small samples** by definition. Treat the trend over
days as more reliable than any single percentile.

## Causes

For each queued job the tool reports one of:

| Cause | Meaning |
|---|---|
| `scheduling` | A free runner is labelled for the job and has not picked it up yet |
| `all_busy` | Every online runner with matching labels is working |
| `no_runners_online` | Nothing is online to run it |
| `runner_offline` | The only matching runners are offline |
| `label_mismatch` | No runner carries the labels the job requires |
| `unknown_capacity` | Runner state unavailable; the cause is undetermined |

## Configuration

Copy `runner-queue.config.example.json` to `runner-queue.config.json`.

| Key | Default | Meaning |
|---|---|---|
| `orgs` | `[]` | Organisations to watch |
| `thresholdMinutes` | `10` | A job waiting longer is "stuck" |
| `historyDays` | `30` | Days of completed runs to analyse |
| `historySample` | `40` | Runs sampled per repo for history |
| `onlyRepos` / `ignoreRepos` | `[]` | Repo filters; cannot use both |
| `defaultBranch` | `"main"` | Branch read when linting workflows |
| `fleet.idleCeiling` | `0.15` | Idle share above which adding runners is not the answer |
| `fleet.targetUtilisation` | `0.8` | Utilisation that counts as saturated |
| `alerts.enabled` | `false` | POST to a webhook when the queue stays bad |
| `alerts.sustainedMinutes` | `15` | How long it must stay bad before alerting |
| `alerts.cooldownMinutes` | `60` | Minimum gap between alerts |
| `write.allowCancel` | `false` | Allow cancelling queued runs |
| `write.allowRerun` | `false` | Allow re-running runs |

Unknown keys are rejected, so a typo fails loudly instead of silently doing
nothing.

## Alerts

Set `alerts.enabled` and a `webhookUrl` (Slack, Teams, or anything accepting a
JSON POST) and the server will notify you when the queue stays bad for longer
than `sustainedMinutes`. Cooldown prevents one long incident from paging
repeatedly.

## Changing things in GitHub

Cancelling and re-running are **off by default**. They change state on someone
else's CI, so they have to be opted into:

```json
{ "write": { "allowCancel": true } }
```

Cancelling a *queued* run is safe — nothing has executed yet. The tool
additionally refuses to cancel `dynamic` (Dependabot) runs: those all report
the base branch as their head branch, so they look like duplicates of each
other when they are actually separate dependency updates.

## Sharing a snapshot

`http://localhost:7777/snapshot` is a self-contained read-only page with no
controls and no credentials, safe to send to someone who cannot run this
themselves.

## Development

```sh
npm test          # 35 tests, no network access required
node --check src/*.js
```

The tests cover the analytics aggregation, every diagnosis branch, the
superseded-run rules, fleet sizing, alert gating, the linter and config
parsing. Two of them exist because they caught real bugs: `runs-on:
[self-hosted, macos]` was being read as two alternative runners rather than a
conjunction, and offline runners were being reported as "busy".

## Licence

MIT
