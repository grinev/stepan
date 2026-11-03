# Development

## Setup

Node.js 22 or newer, npm.

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
Every later write location must use this same resolver.

Definitions and state share `.stepan/` to avoid reserving a generic top-level `flows/` directory.
Commit `.stepan/flows/` and ignore only `.stepan/runs/`, not the whole `.stepan/` directory.
Source-mode state stays inside the ignored `.dev-data/`; it is not written alongside the input
definitions. There is no global lookup or fallback to a top-level `flows/` directory.

Runs use `<write root>/.stepan/runs/<run-id>.json`, format version 1. IDs are eight lowercase
hex characters generated with `node:crypto.randomBytes(4)` and are validated before file access;
the stored ID must match the filename. The file also stores `flowName` for listing, in addition
to the task, step, finished flag, flow snapshot and outcomes. Every `start` creates a new run with
exclusive creation (`wx`); a collision generates another ID, up to ten attempts, without replacing
existing files. Finished runs are retained until explicitly deleted with `rm`.

`next` and `rm` take an exclusive `<write root>/.stepan/runs/<run-id>.lock`. Different runs
do not share a lock. `next` reads the actual state, parses dynamic outcome flags against that
state's current step, validates the outcome and writes the transition under the same lock.
The store accepts a callback over current state; CLI parsing stays in `main`, not in the core.
There is no preliminary snapshot read or externally supplied step argument.
`rm` unlinks the selected file without parsing it, allowing damaged runs to be removed.
`current` and `runs` only read and do not acquire locks or create directories.

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
