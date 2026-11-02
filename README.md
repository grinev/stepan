# Stepan

**CLI for agent workflows.** The agent pulls the next step; Stepan holds the flow.

> **Status: early development.** `start` and `current` are implemented. `next`, `abort`, placeholder
> substitution and checks are not implemented yet.

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

The flow is YAML plus one Markdown file per step. The full product will validate each reported outcome, run
the deterministic checks attached to it and decide what comes next. It is designed for any agent
harness that has a shell — Claude Code, OpenCode, Codex and others — without knowing about
your task tracker: tracker commands will be declared in the flow, not built into the core.

## Available now

Put `flow.yaml` and the Markdown instructions in `flows/<name>/` in your working directory; the
format is specified in [PRODUCT.md](./PRODUCT.md#flow). Then run:

```sh
stepan start <name> <task>
stepan current
```

`start` validates the entire flow, saves a snapshot of its graph and instruction texts, and prints
the graph and first instruction with a `stepan next` exit template. The template describes the
next action; `next` itself is not available yet. Placeholders remain literal until substitution
is implemented. A live or unreadable run is never overwritten; a finished run may be replaced.

`current` repeats only the current instruction and exit template from the saved snapshot, even
if the original YAML or Markdown files have changed or been removed. It does not modify the run.
Without a run, or with an unreadable run, it reports an error. A finished run reports
`Run is finished.` and exits successfully without printing a step.

Installed packages save `.stepan/run.json` in the working directory. From sources, build and run
`node dist/cli.js start <name> <task>`; state goes into this repository's `.dev-data/` instead.
`node dist/cli.js current` reads that same source-mode state.

What Stepan is meant to become: [PRODUCT.md](./PRODUCT.md).

## Development

See [docs/development.md](./docs/development.md).

## License

[MIT](./LICENSE)
