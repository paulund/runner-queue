# Contributing

Thanks for looking at this. A few things will make your change easy to accept.

## Running it

```sh
npm ci
npm run check     # typecheck, then the tests
npm test          # tests on their own
node src/cli.js jobs --org YourOrg
```

`npm run check` is what CI runs, and it is expected to pass before a change is
merged.

## Scope

`jobs` and `wait` are read-only, and that is deliberate: nothing in them can
change your CI, so there is no write permission to grant, no opt-in flag to
forget, and no way for either to be the thing that broke a build.

`clean` is the exception, and the only command that writes to anything. It is
local to the runner host and needs no GitHub permission, but the principle is
the same one applied harder:

- **It deletes nothing without `--apply`.** The default is a dry run.
- **`--apply` is an option, not a setting.** A destructive action that a config
  file can switch on is a destructive action that will eventually be switched on
  by accident. `--apply`, `--prune` and `--report` live in `OPTIONS`.
- **Deletion happens behind an age threshold** (`--cleanup-age-hours`), checked
  before anything is removed rather than at the point of removal. A directory
  still in use has a recent mtime; that is the whole of the safety.

If you add a command that writes to GitHub, or that deletes anything without an
opt-in flag, expect to be asked how it cannot be done by accident. The answer
should be structural, not a warning in the help text.

## No runtime dependencies

The tool has none, and keeping it that way is a design decision rather than an
accident of where it started. A queue diagnostic that pulls in a dependency tree
is one that breaks on someone else's machine at the worst possible moment. Node's
standard library and the `gh` CLI are the whole toolbox.

The two dev dependencies — TypeScript and `@types/node` — exist only to
typecheck the JSDoc annotations. Nothing ships because of them.

## Tests

`node --test`, no framework. Tests live in `test/`, one file per module, and
must not need a network or credentials.

Both commands talk to GitHub, so they take their data source as an argument:

```js
await cmdJobs(config, { json: true }, { queueFor: async () => fixture });
```

That seam is why the presentation — what gets printed, and which exit code comes
out — can be tested at all. If you add a command, give it the same seam rather
than reaching for a live API in a test.

`clean` takes the same seam, and its tests use it in a deliberately mixed way.
`scan` and `diskUsage` are left as the real functions, pointed at a temporary
tree, so the age arithmetic and the directory walk are actually exercised.
`remove` and `pruneWorktrees` are stubbed, because those are the operations that
must never be pointed at anything real in a test.

The report writer is left real too, in one test, because the name of the file
and the `runner` field inside it have to agree — a stub returning a fixed path
would not notice if they diverged.

Tests worth reading before you touch the code they cover, because each exists
because it caught a real bug:

- `test/diagnose.test.js` — a job whose only matching runners are offline reads
  as `runner_offline`, and a job never matches another org's runners.
- `test/github.test.js` — only jobs whose own status is `queued` count as
  waiting, because GitHub leaves a run marked `queued` while its jobs run.
- `test/hosts.test.js` — age is floored, not rounded up, so a checkout is never
  deleted before the threshold the command prints.
- `test/hosts.test.js` — a symlink out of `_work` is refused rather than
  followed. `git worktree` creates exactly those, so this is the real shape.
- `test/hosts.test.js` — a runner nobody reported on is `null`, not `false`. A
  host with no report and a host reported healthy have to stay distinguishable,
  or adding reports for one machine starts explaining queues for every other.

Prefer a test that fails before your fix over one that passes after it.

## Adding a setting

Every setting lives in one table, `SCHEMA` in `src/config.js`, which declares its
type, default, flag and environment variable. Adding an entry there gives you
the flag, the environment variable, validation, and a line in `--help`, because
all of those are generated from it. There is no second list to update — if you
find yourself adding one, the table is in the wrong place.

Two rules the table relies on:

- **A setting that does nothing is worse than no setting.** It reads as working.
  A test enforces this by checking the sources for each key.
- **A value that cannot be right should fail loudly.** A typo in a config file
  should stop the command, not silently do nothing.

Anything that must not persist across invocations — `--apply` above all — does
not belong in this table. `OPTIONS` in `src/args.js` is the other list: switches
that apply to one run and are never read from a config file.

## Changing output

`--json` output is part of the interface: scripts and agents read it. Add fields
rather than renaming or removing them, and keep the same names across commands
(`orgs`, `summary`, `capacity`, `unknownOrgs`, `runnerErrors`).

Exit codes are part of it too: `0` nothing to do, `1` the command could not do
its job, `2` it worked and found something to act on.

Add a key rather than leaving it out when it has no data. A `hosts` key that
appears only when reports happen to exist makes `--json` output change shape
between runs, and callers have to handle both. `null` is the honest value for
"not looked at".

## Reporting a diagnosis you think is wrong

The interesting bugs in this tool are the ones where it confidently names a
wrong cause. If you find one, the most useful thing is the shape of the input
that produced it — the job labels, the runner labels and their statuses, which
organisation each belonged to, and any host reports that were in play. A failing
test built from that is ideal.

This is why `host_disk_pressure` only fires when *every* eligible runner is
reported tight. One machine with room is still somewhere for the job to go, and
the answer is capacity rather than disk.

## Licence

MIT. Contributions are accepted under the same terms.
