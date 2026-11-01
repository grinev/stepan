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
installed packages use the working directory. Flow input is always read from the working
directory. Every later write location must use this same resolver.

`start` saves `<write root>/.stepan/run.json`. After validating the entire flow, it takes an
exclusive `<write root>/.stepan/start.lock` while reading the old state and saving the new run.
Locking the read as well as the write prevents two starts from both replacing the same finished
run and overwriting the first new live run. The lock is released on ordinary success or failure.
If a process crashes and leaves the lock behind, confirm no `start` is running before manually
removing that lock; Stepan does not guess whether it is stale. This is not crash recovery for an
interrupted state-file write. Harness configuration and hooks are not implemented yet.

## Platforms

Windows, macOS and Linux, Windows natively — not only under WSL. No POSIX-only APIs (`fcntl`,
signals other than `SIGINT`/`SIGTERM`), paths through `node:path`, shell commands from a flow
run through a shell available on the platform.
