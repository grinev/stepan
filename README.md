# Stepan

**CLI for agent workflows.** The agent pulls the next step; Stepan holds the flow.

> **Status: early development.** `start`, `current`, `next` and instruction placeholder substitution
> are implemented. `abort` and checks are not implemented yet.

Coding agents follow a workflow written as prose: one long instruction loaded at the start of a
session. By the time the agent reaches the review step, the rules for it are a hundred thousand
tokens behind, and nothing stops it from declaring "done" without calling the reviewer.

Stepan turns the workflow into a graph the agent walks one step at a time, inside its own
session. The intended workflow is:

```sh
stepan start feature TASK-12   # the whole graph at a glance + instructions for the first step
stepan next review --verdict pass --findings 0   # report the outcome, get the next step
stepan current                 # repeat the current step — after a restart or a context compaction
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
stepan current
stepan next <step> --<field> <value>
```

`start` validates the entire flow, saves a snapshot of its graph and instruction texts, and prints
the graph and first instruction with a `stepan next` exit template. Replace the template values
with the step's actual outcome. A live or unreadable run is never overwritten; a finished run
may be replaced.

`current` repeats only the current instruction and exit template from the saved snapshot, even
if the original YAML or Markdown files have changed or been removed. It does not modify the run.
Without a run, or with an unreadable run, it reports an error. A finished run reports
`Run is finished.` and exits successfully without printing a step.

`next` takes the current step id first, then its outcome fields as long flags. It validates
required fields and enum values, saves the outcome, follows the first matching transition (or
the default), and prints the next instruction and exit template from the snapshot. Cycles work;
revisiting a step replaces its previous outcome. A wrong step, invalid outcome or unmatched
transition leaves the run unchanged.

Entering a final step does not finish the run: report that step's outcome with `next` too. It then
prints `Run is finished.`; later `next` calls fail, while `current` exits successfully. An outcome
may be empty when the step has no required fields. Use `stepan next --help` for usage; after the
step id, `--help` is an ordinary outcome field, not a help option. `--field=value` is also
accepted and is required for values beginning with `-`. Unknown or repeated flags are usage errors.

Instructions can use `{{task}}` for the task argument and `{{steps.<id>.outcome.<field>}}` for a
step's latest saved outcome. All three commands substitute these references before printing.
For example, after `stepan start feature TASK-12` and
`stepan next plan --plan "docs/plan.md"`, the next instruction:

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

Installed packages save `.stepan/run.json` in the working directory. From sources, build and run
`node dist/cli.js start <name> <task>`; state goes into this repository's `.dev-data/` instead.
`node dist/cli.js current` reads that same source-mode state.
`node dist/cli.js next <step> --<field> <value>` advances it.

What Stepan is meant to become: [PRODUCT.md](./PRODUCT.md).

## Development

See [docs/development.md](./docs/development.md).

## License

[MIT](./LICENSE)
