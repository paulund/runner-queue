# runner-queue

See what your GitHub self-hosted runner queue is doing, and why.

GitHub shows you a "Queued jobs" panel, but it does not tell you *why* a job
has been sitting there for six hours, how much of your team's day that has
cost, or whether the answer is more runners or a missing label. This tool
answers those questions, from the same public API the Actions tab uses.

Three commands:

- **`jobs`** — the queue, longest wait first, with a plain-English cause for
  each job.
- **`wait`** — wait-time percentiles, time-to-green, and job-hours lost to
  queueing, so the cost of a slow queue is a number you can argue with.
- **`clean`** — the one command that changes anything. It reports what a runner
  host is still carrying from finished jobs and removes it, on request only.

## Install

```sh
git clone https://github.com/paulund/runner-queue
cd runner-queue
node src/cli.js jobs --org YourOrg
```

Requires Node 22 or newer. There are no runtime dependencies.

### Setup

Credentials come from the [GitHub CLI](https://cli.github.com), which this tool
shells out to rather than reading a token. Yours stay in your keychain: this
process never sees them, never logs them, and never puts them in a browser.

```sh
gh auth login
```

Listing runners is an organisation-admin operation, so it needs one more scope:

```sh
gh auth refresh -h github.com -s admin:org
```

Without it the tool still runs, and says plainly that capacity is unknown rather
than guessing at a cause. For GitHub Enterprise, set `GH_HOST` as you would for
`gh`; the tool follows it.

## Commands

```sh
runner-queue jobs      # what is queued, and why it is stuck
runner-queue wait      # wait-time analytics from recent runs
```

Flags work on either side of the command name, so `runner-queue --org acme jobs`
and `runner-queue jobs --org acme` are the same command. Run
`runner-queue --help` for every setting with its flag, config key and environment
variable.

---

### `jobs`

What is waiting for a runner, longest wait first, and why.

```sh
runner-queue jobs --org YourOrg
runner-queue jobs --org YourOrg --json
runner-queue jobs --org YourOrg --threshold 30   # call it stuck sooner
```

```
7 job(s) queued across 2 repo(s) in YourOrg.

Worst  YourOrg/api  main → Dependabot
       waiting 18h 41m
       cause   label_mismatch
       No runner is labelled "dependabot". Online runners carry: self-hosted, macOS, X64.

All 2 jobs over 10m:
  waiting    run                                       cause
    18h 41m  YourOrg/api  main  Dependabot             label_mismatch
    16h 37m  YourOrg/api  main  Dependabot             label_mismatch

2 job(s) also queued, all under the 10m threshold.

Runners
  YourOrg  0 free, 1 busy, 0 offline (1 total)
```

Reading it:

- **The worst job leads**, because a single 18-hour job is the one worth acting
  on. If nothing is over `--threshold`, the whole job is a one-liner.
- **Cause is the actionable part.** See the [causes table](#causes). The colour
  follows it: green is about to start, yellow is a bottleneck, red needs a
  change.
- **Jobs under the threshold are counted, not listed.** They are not a problem
  yet, and a wall of two-minute waits buries the ones that are.
- **Runners are reported even when they are not the cause**, so you can tell
  "nothing can run this" from "nothing is free".
- **A missing `admin:org` scope is stated, not hidden.** The queue still
  appears; only the cause degrades to `unknown`.

Exits `2` when any job is over the threshold, `0` otherwise, `1` if it could not
run at all. That makes it usable as a check:

```sh
runner-queue jobs --org YourOrg || echo "the queue is stuck"
```

`--json` gives `orgs`, `generatedAt`, `thresholdMinutes`, `summary` (queued jobs,
stuck jobs, repos with work, oldest wait), `capacity`, `unknownOrgs`,
`runnerErrors`, `unreadableRepos`, and a `jobs` array with each job's
`repo`, `branch`, `jobName`, `labels`, `waitS`, `cause` and `detail`.

---

### `wait`

What the waiting has actually cost, from completed runs.

```sh
runner-queue wait --org YourOrg
runner-queue wait --org YourOrg --history-days 7
runner-queue wait --org YourOrg --json
```

```
Wait times over the last 14 day(s) with completed runs, 345 job samples from 5 repo(s).

  median wait   3m 25s
  p90 wait      1h 25s   (n=345)
  worst wait    13h 05m

  median run    13m 48s created to finished
  queue share   38% of that is queue wait

  blocked CI    230 job-hours across 14 day(s)

Worst workflows:
     1h 25m p90  n=  42  YourOrg/api   Test
     54m 0s p90  n=  38  YourOrg/web   Nightly
```

Reading it:

- **The sample size is printed next to every percentile.** A p90 from five jobs
  is not a measurement, and the number in brackets is there so you notice.
- **`queue share` is the part you can fix.** A run that takes 13 minutes and
  spends 38% of that waiting is not a slow build; it is a queue problem wearing a
  slow build's clothes.
- **`blocked CI` is the number to take to someone.** Job-hours of pure delay —
  work that was ready and could not start. Jobs waiting in parallel each count,
  so read it as job-hours of delay, not elapsed hours.
- **The worst workflows are ranked by p90**, not by total, so one busy day does
  not outrank a workflow that is always slow.
- **This reads completed history, so it is slower than `jobs`** the first time.
  Results cache for six hours, keyed by every setting that shaped them, so a
  second run is instant. `(cached)` appears when you are reading the cache.

`--json` gives the same figures plus the raw data behind them: `overall`,
`byRepo`, `workflows`, `daily`, `failures`, `timeToGreen`, `blockedHours` and
the per-job `samples`.

---

### `clean`

What a runner host is still carrying from jobs that finished. Run it on the
runner.

```sh
runner-queue clean                            # report only, deletes nothing
runner-queue clean --apply                    # actually remove them
runner-queue clean --apply --prune            # also tidy git's worktree records
runner-queue clean --report --apply           # and write a report for `jobs`
```

```
Would remove 3 checkout(s) older than 24h:

    72h  acme/api/main
   120h  acme/api/release
    72h  acme/web/main

  Kept 1 checkout(s) under 24h old:
         0h  acme/api/dev

  disk  168.2 GiB free of 192.7 GiB (87%)

  git worktree prune ran in 2 repository checkout(s).

  Nothing was deleted. Re-run with --apply to remove them.
```

Reading it:

- **Nothing is deleted without `--apply`.** The default is a dry run. This is the
  one command in the tool that changes anything, so it is built so that running
  it out of curiosity cannot hurt anything.
- **`--apply` is a flag, deliberately not a setting.** It cannot be switched on in
  a config file and then forgotten about.
- **Only checkouts older than `--cleanup-age-hours` (default 24) are
  candidates.** A directory the runner is still using has a recent mtime, so that
  threshold is what stands between a running job and a deletion. Set it above
  your longest job.
- **`git worktree prune` is separate from the removals** and is reported
  separately, because it does something different: it removes git's own records
  of worktrees whose directories are already gone.
- **`_temp` and the other runner-owned directories are never candidates.**
  `_temp` can hold a job mid-transfer; deleting it corrupts a run rather than
  tidying one.
- **Every path is resolved and checked to be inside `_work`** before removal, so
  a symlink cannot redirect the deletion. `git worktree` creates exactly those
  symlinks, which makes this a real shape rather than a precaution.

Exit code is `2` when there is something to clean, `0` when there is not, and `1`
if a removal failed — so `clean` can run from cron and tell you when a runner is
filling up. Add `--json` for the same report as data.

#### Reporting disk to `jobs`

`--report` writes a small JSON file per runner into `--host-report-dir`, and
`jobs --host-report-dir` reads them back. That is the loop: `clean` frees the
space, and `jobs` is what tells you it needed freeing.

```yaml
# On the runner, as a scheduled job:
- run: runner-queue clean --apply --prune --report --host-report-dir /var/tmp/rq
```

The runner names itself, so nothing else needs configuring — `RUNNER_NAME`
identifies the runner, and `RUNNER_WORK` finds `_work`.

A written report:

```json
{
  "runner": "runner-07",
  "hostname": "build07",
  "at": "2026-10-01T08:20:56.663Z",
  "workDir": "/opt/actions-runner/_work",
  "disk": { "totalBytes": 500107862016, "freeBytes": 2013265920, "freePercent": 0.4 },
  "workDirCount": 2,
  "staleWorkDirs": 1,
  "removedWorkDirs": 1,
  "prunedWorktrees": 2,
  "errors": []
}
```

- **It counts rather than lists the work directories.** The report is written
  *after* the removals, so an inventory taken beforehand would describe
  directories that no longer exist — and `jobs` reads this to judge whether a
  disk is full, where a stale inventory is worse than none.
- **A dry run still reports.** "This host is nearly full" is true whether or not
  `--apply` was passed, and the dry run is often the one you want on a schedule.
- **`errors` is carried in the report too**, so a removal that failed with
  `EACCES` is visible from the machine reading the reports, not only on the host
  where it happened.

Then, from wherever you can read those reports:

```sh
runner-queue jobs --org YourOrg --host-report-dir /var/tmp/rq
```

```
Hosts
  runner-01  94% free
  runner-02  0% free     under 5%
  runner-03              disk unknown
```

A host is one JSON file per runner, named `<runner>.json`, which is what
`clean --report` writes and what the block above shows.

Reading it:

- **A queued job gets `host_disk_pressure` instead of `scheduling` or
  `all_busy`** when every runner that could have taken it is on a host reported
  out of disk. It is red, because nothing in the Actions tab looks wrong.
- **One machine with room is enough to keep the ordinary cause.** Only when
  *every* eligible runner is tight is it a disk problem; otherwise the answer is
  capacity.
- **A host with no report is not reported as healthy.** It is not reported at
  all, and if the directory is empty the tool says so, so you never read silence
  as health.
- **A stale report is ignored rather than trusted.** Past
  `--host-report-max-age` (default 30 minutes) it stops counting, because a
  report saying the disk was fine an hour ago is worse than no report at all.
- **A host with no disk figures says `disk unknown`** rather than showing a
  number it does not have.

This is entirely optional and additive. With no `--host-report-dir`, `jobs`
behaves exactly as it did before.

---

### Exit codes

| Code | Meaning |
|---|---|
| `0` | nothing needs your attention |
| `1` | the command could not do its job |
| `2` | it worked, and something is waiting too long |

That is the point of `2`: `jobs` exits `2` when a job is over the threshold, so a
cron job or a CI step can act on that without parsing anything. Add
`--exit-zero` if you would rather not.

## Configuration

Every setting can be given three ways. In order of precedence:

1. a flag — `--threshold 15`
2. an environment variable — `RUNNER_QUEUE_THRESHOLD_MINUTES=15`
3. a config file
4. the built-in default

Nothing needs a config file; `--org YourOrg` is enough to get started. For a
setting you want to keep, copy the example and edit it:

```sh
cp runner-queue.config.example.json runner-queue.config.json
$EDITOR runner-queue.config.json     # set "orgs": ["YourOrg"]
```

The file is looked for in this order, and the first that exists wins:

1. `--config <path>`
2. `$RUNNER_QUEUE_CONFIG`
3. `./runner-queue.config.json`
4. `$XDG_CONFIG_HOME/runner-queue/runner-queue.config.json`, or
   `~/.config/runner-queue/runner-queue.config.json`

### Settings

| Config key | Flag | Environment | Default | What it does |
|---|---|---|---|---|
| `orgs` | `--org` | `RUNNER_QUEUE_ORG` | `[]` | Organisations to watch. Repeatable. A job is only ever matched against its own org's runners |
| `thresholdMinutes` | `--threshold` | `RUNNER_QUEUE_THRESHOLD_MINUTES` | `10` | A job waiting longer than this counts as stuck |
| `historyDays` | `--history-days` | `RUNNER_QUEUE_HISTORY_DAYS` | `30` | Days of completed runs to analyse |
| `historySample` | `--history-sample` | `RUNNER_QUEUE_HISTORY_SAMPLE` | `40` | Completed runs sampled per repo |
| `onlyRepos` | `--only-repo` | `RUNNER_QUEUE_ONLY_REPOS` | `[]` | Only these repos. Cannot be combined with `ignoreRepos` |
| `ignoreRepos` | `--ignore-repo` | `RUNNER_QUEUE_IGNORE_REPOS` | `[]` | Skip these repos. Cannot be combined with `onlyRepos` |
| `includeArchived` | `--archived` | `RUNNER_QUEUE_INCLUDE_ARCHIVED` | `false` | Include archived repositories |
| `concurrency` | `--concurrency` | `RUNNER_QUEUE_CONCURRENCY` | `8` | GitHub requests in flight at once |
| `queueRunPages` | `--queue-pages` | `RUNNER_QUEUE_QUEUE_PAGES` | `2` | Pages of queued runs to read per repo, 100 each. Raise it for a deep backlog |
| `cacheDir` | `--cache-dir` | `RUNNER_QUEUE_CACHE` | `$XDG_CACHE_HOME/runner-queue` | Where history is cached |
| `workDir` | `--work-dir` | `RUNNER_WORK` | `$RUNNER_WORK` | A runner's `_work` directory, for `clean`. The runner exports this itself, so it usually needs no configuration |
| `cleanupAgeHours` | `--cleanup-age-hours` | `RUNNER_QUEUE_CLEANUP_AGE_HOURS` | `24` | How old a checkout has to be before `clean` will remove it |
| `hostReportDir` | `--host-report-dir` | `RUNNER_QUEUE_HOST_REPORT_DIR` | `null` | Directory of host reports. Written by `clean --report`, read by `jobs` |
| `hostReportMaxAgeMinutes` | `--host-report-max-age` | `RUNNER_QUEUE_HOST_REPORT_MAX_AGE` | `30` | How old a host report may be before `jobs` ignores it |
| `hostDiskFreePercent` | `--host-disk-free` | `RUNNER_QUEUE_HOST_DISK_FREE` | `5` | Free disk percent below which a host counts as out of space |

Unknown keys are rejected, so a typo fails loudly instead of silently doing
nothing.

## How the numbers are computed

**Wait time** comes from job timestamps: `started_at - created_at` for jobs that
actually started. Run-level `run_started_at` is not used, because GitHub sets it
equal to `created_at` even for runs that never started, so it reports a wait of
zero for jobs that have been queued for hours.

**Only jobs that are still waiting are counted.** A run is left marked `queued`
by GitHub while its jobs are already running, so the run's own status cannot be
trusted: reading it at face value reports jobs that have been running for an
hour — and jobs that finished twenty minutes ago — as queued, with the wait
measured to *now* instead of to the moment a runner picked the job up.

**Time-to-green** is run creation to run completion, which is the delay a
developer actually feels after pushing. The tool reports what share of that is
queue wait, since that is the part you can fix.

**Job-hours blocked** sums the wait of every job. Jobs that wait in parallel each
count, so read it as "job-hours of delay", not elapsed wall-clock hours.

Every percentile is shown with its sample size. A p90 computed from five jobs is
not a measurement, and the tool does not pretend otherwise. **Percentiles are
noisy on small samples** by definition: treat the trend over days as more
reliable than any single percentile.

## Causes

For each queued job the tool reports one of:

| Cause | Meaning | What to do |
|---|---|---|
| `scheduling` | A free runner is labelled for the job and has not picked it up yet | Usually nothing; it is about to start |
| `all_busy` | Every online runner with matching labels is working | Wait, or add capacity |
| `no_runners_online` | Nothing is online to run it | Start the fleet |
| `runner_offline` | The only matching runners are offline | Switch them on, or add more |
| `label_mismatch` | No runner carries the labels the job requires | Fix the labels, in the workflow or on the runner |
| `host_disk_pressure` | Every runner that could take this job is on a host reported out of disk | Free space on the host, then `clean` |
| `unknown_capacity` | Runner state unavailable; the cause is undetermined | Grant the `admin:org` scope |

`host_disk_pressure` needs host reports to be configured; see
[checking runner disk space](#checking-runner-disk-space). Without them the tool
cannot tell a full disk from a healthy idle runner, and says `scheduling` as
before.

## `--json`

Both commands take `--json`, and the shape is stable so a script written
against one keeps working.

```sh
runner-queue jobs --org YourOrg --json | jq '.jobs[0] | {repo, waitS, cause}'
```

Colour is always off in JSON, so the output is parseable even when the terminal
supports it.

See each command above for its own keys.

`unknownOrgs` and `runnerErrors` are how a partial answer says so: if one
organisation's runners could not be read, the others are still diagnosed and the
gap is named rather than papered over. `unreadableRepos` does the same for
repositories that could not be listed, so a short queue is never mistaken for a
quiet one.

## Known limitations

**Lint-free by design, and it costs you something.** There is no `lint` command,
so nothing here will tell you *beforehand* that a workflow asks for a label no
runner carries. GitHub also substitutes required labels at runtime for
Dependabot-triggered runs — a workflow saying `runs-on: self-hosted` still gets
`labels: ["dependabot"]` — which cannot be seen by reading the file at all.
Expect to catch that with `jobs`, not before it.

**Not a scheduler.** This reports. It does not cancel, re-run, or resize
anything, so there is nothing here that can change your CI.

## Development

```sh
npm ci
npm run check     # typecheck, then the tests. Neither needs a network.
```

Both commands reach GitHub, so their presentation is tested by injecting the
data they would have fetched — which is why there are no credentials needed to
run the suite. See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions,
including the ones about adding a setting.

## Licence

MIT
