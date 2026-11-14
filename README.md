# Stepan

**Step-by-step workflows for coding agents.**

Stepan is a CLI for agent workflows defined as graphs of steps. Your agent gets one
instruction at a time, does the work, and reports the result. Stepan keeps the run state,
validates the reported outcome, and decides what comes next — including returns for rework.

The agent stays in its own session, with its tools, skills, and project context.
Works with OpenCode, Claude Code, Codex, or any agent that can run shell commands.

## Install

Requires Node.js 22+. Installing flows also requires Git on PATH.

```sh
npm install -g @grinev/stepan
```

Without a global install, have the agent use `npx @grinev/stepan@latest <command>`
instead of `stepan <command>`, including printed `next` commands.

## Start a workflow

Install a flow in your project:

```sh
stepan install grinev/stepan-flows --flow plan-and-implement
```

This flow goes **plan → approve-plan → implement → finish**.
The user approves the current plan before implementation; requested changes return to planning.
Read third-party flow instructions before asking an agent to follow them.

Add an instruction like this to your project's `AGENTS.md` or equivalent:

```markdown
Use the plan-and-implement flow for implementation tasks.
Start with `stepan start plan-and-implement "<task description>"` and follow the instructions.
```

On `start`, Stepan creates a run with its own ID and returns the first step's instructions
and the next command. After doing the work, the agent calls `next` with its result and gets
the following step. An abbreviated example of this exchange:

```text
$ stepan start plan-and-implement "<task description>"
Run: a7c93f2b
Step: plan
Instructions:
<plan instructions>
After completing this step, run:
stepan next a7c93f2b --plan "<text>"

$ stepan next a7c93f2b --plan "docs/plan.md"
Run: a7c93f2b
Step: approve-plan
Instructions:
<approval instructions>
After completing this step, run:
stepan next a7c93f2b --decision <approved|changes> [--feedback "<text>"]
```

The agent repeats this cycle until it reports completion of the final step.

Validating an outcome does not prove that work, a check, or an approval actually happened.

## Create your own flow

Install the optional authoring skill:

```sh
npx skills add grinev/stepan --skill stepan-flow-creator
```

> Use stepan-flow-creator to create a flow for my process. Discuss the steps,
> decisions, and rework paths with me before creating the files.

The skill includes the full format reference locally and works offline after installation.
It creates and edits flows, not runs. Stepan does not require a skill to execute a flow.

## Flow format

A flow is a YAML graph with Markdown instructions:

```text
.stepan/flows/my-flow/
  flow.yaml
  steps/
    plan.md
    implement.md
```

`flow.yaml` defines the start step, instruction paths, string or enum outcomes, and transitions.

A step under `steps` in `flow.yaml`:

```yaml
implement:
  instruction: steps/implement.md
  outcome:
    summary:
      type: string
      required: true
  transitions:
    - to: finish
```

Instructions use `{{task}}` and `{{steps.<id>.outcome.<field>}}` to receive inputs.
Keep `.stepan/flows/` in Git; ignore only `.stepan/runs/`, not all of `.stepan/`.

[Format reference](https://github.com/grinev/stepan/blob/main/skills/stepan-flow-creator/references/flow-format.md)
· [CLI and product details](https://github.com/grinev/stepan/blob/main/PRODUCT.md)
· [Flow collection](https://github.com/grinev/stepan-flows)

## Development

```sh
npm install
npm run build
npm run check
```

[Development notes](https://github.com/grinev/stepan/blob/main/docs/development.md).
The `main` branch may be ahead of the latest npm release.

[Report an issue](https://github.com/grinev/stepan/issues) with Stepan/Node versions, OS,
agent harness, command, and error. Do not include private outcomes or secrets.

[MIT](https://github.com/grinev/stepan/blob/main/LICENSE)
