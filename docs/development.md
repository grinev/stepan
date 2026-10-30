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

## Tests

- **Unit** — `src/**/*.test.ts`, next to the file under test. Logic with a real branch gets one.
- **e2e** — `test/e2e/`. Runs the built binary as a separate process through `runCli` in
  `test/e2e/run-cli.ts`: a fresh temporary directory per test, used as the working directory and
  as home, `APPDATA` and XDG roots. A user-visible command or behaviour gets an e2e test.
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

The mode follows from how Stepan was started, not from a flag or an environment variable that
someone forgets to set. **Not implemented yet:** Stepan writes nothing today. The first change that
makes it write anywhere introduces this split, and every later write location goes through it.

## Platforms

Windows, macOS and Linux, Windows natively — not only under WSL. No POSIX-only APIs (`fcntl`,
signals other than `SIGINT`/`SIGTERM`), paths through `node:path`, shell commands from a flow
run through a shell available on the platform.
