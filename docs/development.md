# Development

## Setup

Node.js 22 or newer, npm.
Git on PATH is needed for `install` and its tests, not for executing local flows.

```sh
npm install
```

## Commands

| Command             | Does                                                  |
| ------------------- | ----------------------------------------------------- |
| `npm run check`     | the full gate: lint, typecheck, build, tests          |
| `npm run lint`      | ESLint and Prettier check                             |
| `npm run format`    | Prettier write                                        |
| `npm run typecheck` | TypeScript, no output                                 |
| `npm run build`     | compiles `src/` to `dist/`                            |
| `npm test`          | Vitest: unit and e2e; builds `dist/` before the suite |

Run the CLI from sources after a build: `node dist/cli.js <args>`.

Local version preparation, release notes, package checks and the manual npm/GitHub
release procedure are in [Releasing](./releasing.md). Release tooling is not part
of the npm package. The first release's notes are hand-written; subsequent
drafts use Git history and are curated before publication.

Flow parsing validates mapping keys in the YAML AST before converting it to JavaScript objects.
Otherwise distinct YAML keys such as `true` and `"true"` can collapse into one property and hide
an invalid schema. Keys must resolve to strings and remain unique, including alias keys.

## Tests

- **Unit** — `src/**/*.test.ts`, next to the file under test. Logic with a real branch gets one.
- **e2e** — `test/e2e/`. Runs the built binary as a separate process through `runCli` in
  `test/e2e/run-cli.ts`. `createCli` copies `dist`, `package.json` and the runtime package `yaml`
  into a fresh sandbox (`yaml` has no runtime dependencies). It can also copy the source markers
  to test source-mode writes. Both layouts keep the executable, working directory, home,
  `APPDATA` and XDG roots inside the sandbox: invoking the repository's own binary would write
  into its real `.dev-data/`. Reuse a sandbox for successive commands. A user-visible command or
  behaviour gets an e2e test.
- `test/build.global-setup.ts` builds `dist/` once before the suite, so e2e never runs a stale
  build.
- Release tooling uses unit tests in `scripts/*.test.mjs` and real script subprocesses
  against temporary Git repositories with private configuration. It does not add
  release commands to the Stepan CLI or access the network in tests.
- Install tests create local Git repositories inside their sandbox, with a private
  global Git config and `GIT_CONFIG_NOSYSTEM=1`. GitHub/HTTPS source tests use
  `url.*.insteadOf` to map to local repositories; no network or maintainer config
  is needed. Test-only Node preloads inject timeout and filesystem errors in the
  child CLI, without adding production fault-injection flags. The copy of the
  collection's example in `test/fixtures/example/` is an offline fixture, not a
  built-in flow; keep it aligned when the collection's example changes.

## Flow-authoring skill

The Git-distributed Agent Skill consists of `skills/stepan-flow-creator/SKILL.md`
and its self-contained `references/flow-format.md`.
It is not part of the npm `files` allowlist and adds no runtime dependency or example flow.

Keep PRODUCT.md's implemented format and the bundled reference in sync when
the format changes. The deliberate duplication lets an installed skill work offline without
the source checkout; a link back to PRODUCT.md would not provide that contract locally.

Review the skill and reference against the implemented loader and product contract.
To check installation, use a disposable project and private home/config/cache roots
for the external `skills` installer, with telemetry disabled and an explicit target agent,
no global install. Check that the complete reference is installed, not just `SKILL.md`.
Until the files are pushed, local installation does not establish that the documented
GitHub command can fetch them.

## Where Stepan writes, by who runs it

Stepan will write run state, configuration and hooks it installs into agent harnesses (Claude
Code settings, OpenCode plugins). The maintainer uses an installed Stepan on the same machine,
and a copy run from sources must not overwrite its state or replace its hooks.

| Who runs it                           | Where it writes                                            |
| ------------------------------------- | ---------------------------------------------------------- |
| tests                                 | the per-test temporary directory from `runCli`             |
| run from sources (`node dist/cli.js`) | `.dev-data/` in this repository, git-ignored               |
| installed package                     | the user's locations (project directory, `~`, `%APPDATA%`) |

The mode follows from the executable's package root, not from a flag or an environment variable
that someone forgets to set. `writeRoot` in `src/write-root.ts` detects a source checkout by the
presence of both `src/cli.ts` and `tsconfig.build.json` next to the package's `dist/`. These files
are not published (the package includes only `dist/` and package metadata). The source write root
is always the checkout's `.dev-data/`, even when the command's working directory is elsewhere;
installed packages use the working directory. Flow input is always read from
`<working directory>/.stepan/flows/<name>/`, in both modes, independently of the write root.
An instruction path such as `steps/<file>.md` is relative to that flow directory; Stepan does not
search for it elsewhere.
Every later write location must use this same resolver.

`install` also uses `writeRoot`: installed definitions go to
`<write root>/.stepan/flows/`, and temporary bare Git/staging directories live
at `<write root>/.stepan/.install-<random>/`. The latter are removed in `finally`;
ordinary copy failures attempt rollback of the new flow directories only.
Cleanup/rollback failures are explicit errors; empty parent directories may remain.
This is not a crash-atomic transaction. No global state, provenance file, run or
harness settings are created by installation. Existing flow directories and
symlink/junction destination parents are refused.

The installer reads Git objects without checkout to avoid configured smudge
filters. Every Git invocation also overrides `core.hooksPath` to a nonexistent
path in its private temporary tree: a bare clone still updates references and
can otherwise run the user's `reference-transaction` hook. Terminal/askpass
prompts are disabled; SSH is explicitly noninteractive OpenSSH with strict
host-key checking rather than a custom Git SSH wrapper. It validates portable paths and instruction boundaries
before loading staged instructions. `readFlowDefinition` shares YAML AST validation
with the normal loader without opening instruction files. These restrictions
apply to installation, not to manually authored project flows. A successful install
does not imply third-party instructions are safe for an agent to follow.

Source-mode installation does not change the normal cwd-only flow lookup. To
walk a flow installed from sources, change cwd to the checkout's `.dev-data/`
and invoke `node ../dist/cli.js start <name> <task>` after building. From another
project, source-mode installation still writes only to the executable's checkout.

Definitions and state share `.stepan/` to avoid reserving a generic top-level `flows/` directory.
Commit `.stepan/flows/` and ignore only `.stepan/runs/`, not the whole `.stepan/` directory.
Source-mode state stays inside the ignored `.dev-data/`; it is not written alongside the input
definitions. There is no global lookup or fallback to a top-level `flows/` directory.

Runs use `<write root>/.stepan/runs/<run-id>.json`, format version 2. IDs are eight lowercase
hex characters generated with `node:crypto.randomBytes(4)` and are validated before file access;
the stored ID must match the filename. Persist only `version`, `id`, `flowName`, `task` and
`events`. Every `start` creates a new run with
exclusive creation (`wx`); a collision generates another ID, up to ten attempts, without replacing
existing files. Finished runs are retained until explicitly deleted with `rm`.

The exact event shapes and chain invariants are in [PRODUCT.md](../PRODUCT.md#run): one leading
`started` (`at`, `step`), then `transitioned` (`at`, `from`, `to`, `outcome`) and optionally one
terminal `finished` (`at`, `step`, `outcome`). Unknown keys and malformed histories are rejected.
Timestamps are system-clock ISO 8601 UTC with milliseconds; array order, not clock monotonicity,
orders events. Empty outcomes are stored too. Current step, status and latest completed outcomes
are derived in memory, never serialized as caches. No flow text, graph or schema is persisted.
JSON is for machine processing, not manual editing or append-only logging.

Run validation does not load a flow or revalidate historical outcomes/edges against today's
definitions: that would make an already recorded fact depend on a later edit. History records
the visited path, not unvisited branches or the exact historical graph. Active `current` and
`next` use the existing whole-flow loader on project files from the working directory. Missing
files, invalid definitions or a removed current step are explicit errors; valid edits govern
future execution. The format version is not a flow version; no hashes or automatic flow
revision retention are provided. Version 1 and unknown run versions are unsupported, without
migration or modification of existing files; an unrelated old run does not block `start`.

`next` and `rm` take an exclusive `<write root>/.stepan/runs/<run-id>.lock`. Different runs
do not share a lock. `next` reads the actual state, parses dynamic outcome flags against that
state's current step in the current project flow, validates the outcome and writes the transition
under the same lock. The flow is loaded once and the response prepared before writing, so a
later reload cannot fail after state has already advanced. The lock does not protect project
definitions from external editors. An update preserves the header and all previous events and
appends exactly one event; failed validation leaves run bytes unchanged.
The store accepts a callback over current state; CLI parsing stays in `main`, not in the core.
There is no preliminary snapshot read or externally supplied step argument.
`rm` unlinks the selected file without parsing it, allowing damaged runs to be removed.
`current` and `runs` only read and do not acquire locks or create directories. Finished-run
responses and listings do not need a flow definition.

`runs` reads and validates run files, sorts by ID and filters finished runs unless `--all` is
given. It ignores lock files, but reports invalid or unreadable run files instead of hiding them.
Output is a header followed by tab-separated, JSON-quoted cells, so multiline tasks do not break
row boundaries. Selection always requires an explicit full ID: an implicit latest run would let
parallel sessions operate on each other's state. A run is normally driven by one session; this
is state isolation, not working-tree isolation or a binding to a specific harness.

The lock is released on ordinary success or failure. If a process crashes and leaves it behind,
confirm no `next` or `rm` for that run is running before manually removing it; Stepan does not guess whether
it is stale. Writes are synchronous JSON writes, not atomic replacements: this is not crash
recovery for an interrupted state-file write, and a failure during the write can leave unreadable
state. Harness configuration and hooks are not implemented yet.

## Platforms

Windows, macOS and Linux, Windows natively — not only under WSL. No POSIX-only APIs (`fcntl`,
signals other than `SIGINT`/`SIGTERM`), paths through `node:path`, shell commands from a flow
run through a shell available on the platform.
