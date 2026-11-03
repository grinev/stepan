# Stepan

**CLI for agent workflows.** The agent pulls the next step; Stepan holds the flow.

> **Status: early development.** `start`, `current`, `next`, `abort`, `runs`, independent run IDs
> and instruction placeholder substitution are implemented. Checks and hooks are not implemented yet.

Coding agents follow a workflow written as prose: one long instruction loaded at the start of a
session. By the time the agent reaches the review step, the rules for it are a hundred thousand
tokens behind, and nothing stops it from declaring "done" without calling the reviewer.

Stepan turns the workflow into a graph the agent walks one step at a time, inside its own
session. For example, after `start` returns the run ID `a7c93f2b`:

```sh
stepan start feature TASK-12                 # run ID, graph and first instruction
stepan next a7c93f2b --plan "docs/plan.md"    # report the current outcome, get the next instruction
stepan current a7c93f2b                     # repeat the current instruction
stepan runs                                # recover IDs of active runs
stepan runs --all                          # include finished runs
stepan abort a7c93f2b                      # delete this run only
```

The flow is YAML plus one Markdown file per step. Stepan validates each reported outcome and
decides what comes next. The full product will also run deterministic checks. It is designed for any agent
harness that has a shell — Claude Code, OpenCode, Codex and others — without knowing about
your task tracker: tracker commands will be declared in the flow, not built into the core.

## Available now

Put `flow.yaml` and the Markdown instructions in `flows/<name>/` in your working directory; the
format is specified in [PRODUCT.md](./PRODUCT.md#flow). Then run:

```sh
stepan start <name> <task>
stepan current <run-id>
stepan next <run-id> --<field> <value>
stepan abort <run-id>
stepan runs [--all]
```

`start` validates the entire flow, saves a snapshot of its graph and instruction texts, and prints
the graph and first instruction with a `stepan next` exit template. Replace the template values
with the step's actual outcome; the run ID is already filled in. IDs are eight lowercase hex
characters. Each `start` creates a separate run, even for the same flow and task, and never
replaces existing active or finished runs. One session drives a run; several runs can coexist.
This isolates state, not code changes in the working directory; use worktrees for file isolation.

`current` repeats only the current instruction and exit template from the saved snapshot, even
if the original YAML or Markdown files have changed or been removed. It does not modify the run.
Without a run, or with an unreadable run, it reports an error. A finished run reports
`Run <run-id> is finished.` and exits successfully without printing a step.

`next` takes the run ID first, then outcome fields as long flags; it reads the current step from
the run's state, so there is no step argument. It validates
required fields and enum values, saves the outcome, follows the first matching transition (or
the default), and prints the next instruction and exit template from the snapshot. Cycles work;
revisiting a step replaces its previous outcome. An invalid outcome or unmatched
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
Unknown references, including outcomes that have not been reported yet, stay literal; saved
empty strings substitute as empty text. Use the exact forms shown, without spaces inside the
braces. Each instruction is substituted once: task and outcome values are data, so references
inside those values stay literal. The snapshot keeps the original template, and a revisited
step's new outcome supplies the values for subsequent output.

`runs` lists ID, flow, task, current step and status, sorted by ID; `--all` includes retained
finished runs. Cells are tab-separated and JSON-quoted, keeping multiline tasks on one row.
Empty lists succeed. `abort <run-id>` deletes an active, finished or damaged run; a missing run
is an error. Deleted runs disappear from both lists. Commands never implicitly select the latest
run, so parallel sessions cannot accidentally advance each other's state.

Installed packages save `.stepan/runs/<run-id>.json` in the working directory. From sources, build and run
`node dist/cli.js start <name> <task>`; state goes into this repository's `.dev-data/` instead.
`node dist/cli.js current <run-id>` reads that same source-mode state.
`node dist/cli.js next <run-id> --<field> <value>` advances it.

What Stepan is meant to become: [PRODUCT.md](./PRODUCT.md).

## Development

See [docs/development.md](./docs/development.md).

## License

[MIT](./LICENSE)
