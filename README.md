# Stepan

**CLI for agent workflows.** The agent pulls the next step; Stepan holds the flow.

> **Status: early development.** Nothing below works yet — this is what is being built.

Coding agents follow a workflow written as prose: one long instruction loaded at the start of a
session. By the time the agent reaches the review step, the rules for it are a hundred thousand
tokens behind, and nothing stops it from declaring "done" without calling the reviewer.

Stepan turns the workflow into a graph the agent walks one step at a time, inside its own
session:

```sh
stepan start feature TASK-12   # the whole graph at a glance + instructions for the first step
stepan next review --verdict pass --findings 0   # report the outcome, get the next step
stepan current                 # repeat the current step — after a restart or a context compaction
```

The flow is YAML plus one Markdown file per step. Stepan validates each reported outcome, runs
the deterministic checks attached to it and decides what comes next. It works in any agent
harness that has a shell — Claude Code, OpenCode, Codex and others — and knows nothing about
your task tracker: entering and leaving a step runs shell commands you declare.

What Stepan is meant to become: [PRODUCT.md](./PRODUCT.md).

## Development

See [docs/development.md](./docs/development.md).

## License

[MIT](./LICENSE)
