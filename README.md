# Stepan

**CLI for agent workflows.** The agent pulls the next step; Stepan holds the flow.

> **Status: early development.** `install`, `start`, `current`, `next`, `rm`, `runs`, independent run IDs,
> execution history and instruction placeholder substitution are implemented. Checks and hooks are not implemented yet.

Coding agents follow a workflow written as prose: one long instruction loaded at the start of a
session. By the time the agent reaches the review step, the rules for it are a hundred thousand
tokens behind, and nothing stops it from declaring "done" without calling the reviewer.

Stepan turns the workflow into a graph the agent walks one step at a time, inside its own
session. For example, after `start` returns the run ID `a7c93f2b`:

```sh
stepan start feature TASK-12                 # description, run ID and first instruction
stepan next a7c93f2b --plan "docs/plan.md"    # report the current outcome, get the next instruction
stepan current a7c93f2b                     # repeat the current instruction
stepan runs                                # recover IDs of active runs
stepan runs --all                          # include finished runs
stepan rm a7c93f2b                         # delete this run only
```

The flow is YAML plus one Markdown file per step. Stepan validates each reported outcome and
decides what comes next. The full product will also run deterministic checks. It is designed for any agent
harness that has a shell — Claude Code, OpenCode, Codex and others — without knowing about
your task tracker: tracker commands will be declared in the flow, not built into the core.

## Available now

Requires Node.js 22+. Installing flows also requires Git on PATH.

Install a flow from a Git repository, or put `flow.yaml` in `.stepan/flows/<name>/`
and the Markdown instructions in its `steps/` directory yourself.
The format is specified in [PRODUCT.md](./PRODUCT.md#flow). Then run:

```sh
stepan install <source> [--flow <name>] [--ref <branch|tag|commit>]
stepan start <name> <task>
stepan current <run-id>
stepan next <run-id> --<field> <value>
stepan rm <run-id>
stepan runs [--all]
```

Keep `.stepan/flows/` in Git. Add only `.stepan/runs/` to your project's `.gitignore` for local
run state; do not ignore all of `.stepan/`. Flow definitions are read only from the working
directory's `.stepan/flows/`, with no global lookup or fallback to a top-level `flows/` directory.

`start` validates the entire flow, records the initial step and timestamp, and prints
the optional flow description and first instruction with a `stepan next` exit template. Add a
string `description` to `flow.yaml` to explain the flow's purpose, approach and result boundary;
it may be multiline or empty and is printed literally, without placeholder substitution. No graph
is printed, even when the description is absent. `current` and `next` do not repeat it. Replace the template values
with the step's actual outcome; the run ID is already filled in. IDs are eight lowercase hex
characters. Each `start` creates a separate run, even for the same flow and task, and never
replaces existing active or finished runs. One session drives a run; several runs can coexist.
This isolates state, not code changes in the working directory; use worktrees for file isolation.

`current` repeats only the current instruction and exit template from the project's current
flow files. It does not modify the run. Valid edits to YAML and Markdown apply to subsequent
commands; a missing file, invalid definition or removed current step produces an error without
advancing. There is no saved flow snapshot or automatic flow versioning.
Without a run, or with an unreadable run, it reports an error. A finished run reports
`Run <run-id> is finished.` and exits successfully without printing a step.

`next` takes the run ID first, then outcome fields as long flags; it reads the current step from
the run's state, so there is no step argument. It validates
required fields and enum values, saves the outcome, follows the first matching transition (or
the default), and prints the next instruction and exit template from the current project files.
Cycles work; each completed visit and its outcome remain in history. Instructions see the latest
completed outcome of each step, replacing rather than merging previous fields. An invalid outcome or unmatched
transition leaves the run unchanged.

Entering a final step does not finish the run: report that step's outcome with `next` too. It then
prints `Run <run-id> is finished.`; later `next` calls fail, while `current` exits successfully. An outcome
may be empty when the step has no required fields. Use `stepan next --help` for usage; after the
run ID, `--help` is an ordinary outcome field, not a help option. `--field=value` is also
accepted and is required for values beginning with `-`. Unknown or repeated flags are usage errors.

Instructions can use `{{task}}` for the task argument and `{{steps.<id>.outcome.<field>}}` for a
step's latest saved outcome. All three commands substitute these references before printing.
For example, after `stepan start feature TASK-12` and
`stepan next a7c93f2b --plan "docs/plan.md"` (using the ID returned by `start`), the next instruction:

```md
Implement {{task}} using {{steps.plan.outcome.plan}}.
```

prints as `Implement TASK-12 using docs/plan.md.` Stepan inserts the path as text, rather than
reading that file. Explicit inputs like these help resume a step after a restart or compaction.
Syntactically valid outcome references without a stored value print `-`, including references to
unknown steps or fields. This visible marker distinguishes missing data from a saved empty string,
which prints as empty text; a saved `-` looks the same as the marker. Unknown or malformed
placeholders stay literal. Use the exact forms shown, without spaces inside the braces. Each
instruction is substituted once: task and outcome values are data, so references inside those
values stay literal. Project templates remain unchanged; a revisited step's new outcome supplies
the values for subsequent output. Entering a step again does not erase its previous outcome.

`runs` lists ID, flow, task, current step and status, sorted by ID; `--all` includes retained
finished runs. Cells are tab-separated and JSON-quoted, keeping multiline tasks on one row.
Empty lists succeed. `rm <run-id>` deletes an active, finished or damaged run; a missing run
is an error. Deleted runs disappear from both lists. Commands never implicitly select the latest
run, so parallel sessions cannot accidentally advance each other's state.

Run JSON format version 2 contains only `version`, `id`, `flowName`, `task` and ordered `events`:
`started` records the initial step, `transitioned` records each actual `from`/`to` and outcome,
and `finished` records the final step and outcome. Each event has a UTC timestamp with
milliseconds. The current state is derived from this history. Past events are not replayed
against edited definitions: the visited path survives, but the full historical graph is not
preserved. See [PRODUCT.md](./PRODUCT.md#run) for the exact format. Version 1 and unknown
versions are rejected without migration; `rm` can still delete them explicitly. Listings and
finished-run responses do not need the flow files.

Installed packages save `.stepan/runs/<run-id>.json` in the working directory. From sources, build and run
`node dist/cli.js start <name> <task>`; state goes into this repository's `.dev-data/` instead.
`node dist/cli.js current <run-id>` reads that same source-mode state.
`node dist/cli.js next <run-id> --<field> <value>` advances it.

## Install flows

Run in the project where you want the definitions:

```sh
stepan install grinev/stepan-flows --flow example
stepan install https://github.com/grinev/stepan-flows.git
stepan install grinev/stepan-flows --flow example --ref <tag-or-commit>
```

`owner/repo` is GitHub shorthand. Full HTTPS, SSH (including `git@host:path`),
and `file://` Git URLs are also supported. Plain local paths and other Git
protocols are not. Omit `--flow` to install every immediate flow directory under
the source's `.stepan/flows/`; root collection files are ignored. An explicit
`--flow` selects exactly one directory. Without `--ref`, installation uses the
repository's default branch. A ref can name a branch, tag or commit (at least
seven hexadecimal characters for a commit prefix). If a branch and tag share a
name, use `refs/heads/<name>` or `refs/tags/<name>`. Revision expressions are not
supported. Git credential helpers can use existing credentials, but terminal and
askpass prompts are disabled. SSH uses OpenSSH `ssh` on PATH in BatchMode with
strict host-key checking; preconfigure keys/agent and known hosts. Custom
`GIT_SSH*` wrappers and `core.sshCommand` are not used by installation.

Every selected flow is validated before any flow is installed. Existing target
directories, including case-insensitive name collisions, are never overwritten.
Instructions must reference files inside their own flow. Symlinks, submodules,
unsafe paths and names that cannot be used on Windows are refused. Only files
inside selected flows are copied, not run state or agent configuration. The Git
executable flag is retained on platforms that support executable permissions.
The output includes the resolved source, commit and destination paths.

Installed flows are ordinary editable project files, not linked dependencies.
Commit them to your project; running them needs neither Git nor network access.
There is no global installation, automatic update, provenance file or lockfile.
On an ordinary write failure, Stepan attempts to remove only the flows it just
created; empty parent directories may remain. Installation is not crash-atomic.
If temporary-directory cleanup fails after copying, the command reports an error
but installed flows may already exist; inspect the printed path before retrying.

**Review third-party instructions before asking an agent to follow them.**
Installation does not execute source hooks, checkout filters or flow instructions;
format validation does not prove that an instruction is safe or that an agent
actually performed a review or check.

## Try the example

The [separate flow collection](https://github.com/grinev/stepan-flows) includes a three-step example:
`implement -> review -> finish`, with a failed review looping back to `implement`.
It passes `{{task}}`, the latest implementation summary and review findings between instructions.
Install it in your project with an installed Stepan:

```sh
stepan install grinev/stepan-flows --flow example
stepan start example TASK-12
# Use the run ID returned by start in every command below.
stepan next <run-id> --summary "First implementation."
stepan next <run-id> --verdict fail --findings "Add a regression test."
stepan next <run-id> --summary "Implementation with a regression test."
stepan next <run-id> --verdict pass
stepan next <run-id>                         # report the final step and finish the run
stepan current <run-id>                      # reports that the run is finished
stepan runs --all                            # finished runs are retained
```

The reported values above illustrate the graph, not proof that any work was done. In a real
run, follow each instruction and report its actual outcome. Use `stepan current <run-id>` to
resume at any point; use `stepan runs` if you have forgotten an active run's ID.
From a source checkout, installation writes to the checkout's `.dev-data/`, not
the current project's definitions. Flow reads still use the working directory,
so change into `.dev-data/` to try the installed example:

```sh
npm run build
node dist/cli.js install grinev/stepan-flows --flow example
cd .dev-data
node ../dist/cli.js start example TASK-12
```

Continue with `node ../dist/cli.js current <run-id>` and `next <run-id> ...`.
The test-only copy in `test/fixtures/example/` keeps automated tests offline;
it is not shipped in the npm package.

What Stepan is meant to become: [PRODUCT.md](./PRODUCT.md).

## Development

See [docs/development.md](./docs/development.md).

## License

[MIT](./LICENSE)
