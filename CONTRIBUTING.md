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

There are two commands, `jobs` and `wait`, and both are read-only. That is
deliberate: nothing in this tool can change your CI, so there is no write
permission to grant, no opt-in flag to forget, and no way for it to be the thing
that broke a build.

Adding a command that writes to GitHub means adding that whole category back.
The bar should be that it cannot be done by accident.

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

Tests worth reading before you touch the code they cover, because each exists
because it caught a real bug:

- `test/diagnose.test.js` — a job whose only matching runners are offline reads
  as `runner_offline`, and a job never matches another org's runners.
- `test/github.test.js` — only jobs whose own status is `queued` count as
  waiting, because GitHub leaves a run marked `queued` while its jobs run.

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

## Changing output

`--json` output is part of the interface: scripts and agents read it. Add fields
rather than renaming or removing them, and keep the same names across commands
(`orgs`, `summary`, `capacity`, `unknownOrgs`, `runnerErrors`).

Exit codes are part of it too: `0` nothing to do, `1` the command could not do
its job, `2` it worked and found something to act on.

## Reporting a diagnosis you think is wrong

The interesting bugs in this tool are the ones where it confidently names a
wrong cause. If you find one, the most useful thing is the shape of the input
that produced it — the job labels, the runner labels and their statuses, and
which organisation each belonged to. A failing test built from that is ideal.

## Licence

MIT. Contributions are accepted under the same terms.
