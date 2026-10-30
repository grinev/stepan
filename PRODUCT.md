# Stepan — product

What Stepan is and how it behaves. This file describes the current intent; it is not a gate. A
change that goes beyond it updates it in the same change.

**State:** design only. Nothing here is implemented yet.

## Problem

An agent workflow today is prose: one instruction file loaded at the start of a session and
followed from memory. Two things break:

- **the flow is not formal.** Order of steps, round limits and stop points are spread through the
  text; you cannot see the flow at a glance or reuse a step in another flow;
- **the instruction for a step is far behind by the time the step starts.** Hundreds of thousands
  of tokens later — or after a context compaction — the agent works from a faded copy.

Workflow engines solve the first by taking the agent out of its session and driving it node by
node. The node loses what the session had: project MCP servers, skills, subagents.

## Idea

Control is inverted: **the engine does not push the agent, the agent pulls the next step.** The
agent calls the CLI, gets the instruction for the current step only, does it, reports the
outcome; the CLI decides what comes next. One session, with everything the harness offers.

The agent may not declare a step done on its own word: code holds _when_ a reviewer must be
called and what it answered. How the work is done between those points stays with the model.

It is a CLI, not an MCP server: no long-running process, easy to run by hand, callable from
scripts, discoverable through a skill. Works in any harness with a shell.

## Flow definition

- A transition graph in YAML and one `.md` instruction file per step.
- A snapshot of the graph is taken when a run starts: editing the YAML mid-run does not break the
  running flow.

## Commands

| Command                      | Does                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `stepan start <flow> <task>` | starts a run, prints the whole graph and the first step's instruction        |
| `stepan current`             | repeats the current step's instruction — to resume, or after compaction      |
| `stepan next <outcome>`      | takes the step's outcome, runs the checks, returns the next step or an error |
| `stepan show`                | renders the graph as Mermaid                                                 |

**Run state** lives in a run file: current step, outcomes, round counters. A new session calls
`stepan current` and continues where the last one stopped.

**The task tracker is only a reflection.** Stepan does not know about trackers: on entering and
leaving a step it runs shell commands from the YAML
(`on_enter: boardown task status {task} in-progress`). Another tracker, or none, is a different
line in the YAML.

## Step outcome

`next` takes a **structured outcome**, not "I'm done".

- The outcome schema is declared on the step: fields, enums, required. Stepan validates it and on
  failure prints what is missing.
- Outcomes of earlier steps are substituted into the instruction of later ones: a `fix` step gets
  the `review` step's findings as text.
- The outcome carries what checks and later steps need: path to the plan, id of the reviewer
  instance — so a re-check can go to the same instance.

## Checks on `next`

Deterministic shell commands from the YAML, no model involved. In increasing order:

1. **the artifact exists** — a plan file after planning;
2. **the artifact has the right shape** — required sections, filled fields; content is the
   reviewer's job, not grep's;
3. **commands are green** — lint, typecheck, tests by exit code, re-run by Stepan rather than
   taken from the agent's word;
4. **nothing extra was done** — no code changes during planning, no working-tree changes during
   review, commits only in the commit step.

A failed check's output goes back to the agent verbatim. Three failed `next` calls in a row on
one step stop the run for a human; otherwise the agent starts fitting the file to the check.

## Optional steps

Not every task needs the whole flow. But the agent is an interested party: building its own
pipeline, it would first drop the reviewer that keeps it from saying "done". So:

- **required steps cannot be removed.** Code changed — there is a code review; commit only after
  green checks;
- **optional steps are skipped with a reason**, and where possible under a condition code can
  check;
- **what was skipped goes into the report to the human**, with the reason.

One graph with optional steps — not a set of flows per task type, not free assembly from a step
library.

## Keeping the agent on the flow

- Every step's instruction ends with the exit command, printed ready to run with its allowed
  values: `stepan next review --verdict pass|fail --findings N`.
- A long step pushes that line far back, so a harness hook backs it up: a stop hook refuses to let
  the session end while the run is not in a final state; a hook after compaction calls
  `stepan current` and puts the step back into context.

## Also

- **Transition log:** time, step, outcome, round number — step durations without digging through
  session logs.
- **Run mode** `--mode interactive|auto`: a stop either asks in chat or ends the run with
  `needs-answer`.

## Not in the first version

- a step library with per-project overrides — until a second flow needs a step of the first;
- check level 3 before the first time a model lies about a green run;
- free assembly of the pipeline by the model.

## Open questions

- How a step learns whether code changed and whether the diff touches UI — general rules or per
  project.
- Where the run file lives and how it survives `git clean`.
