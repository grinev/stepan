# Stepan — product

What Stepan is and how it behaves. This file describes the current intent; it is not a gate. A
change that goes beyond it updates it in the same change.

**State:** 0.1 is specified below; `start`, `current`, `next` and instruction placeholder
substitution are implemented. `abort` is not implemented yet.

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

## Version 0.1

The first release walks a flow and nothing else: `start`, `current`, `next`, `abort`. No checks,
no hooks, no tracker. This section is the contract; code follows it, not a chat.

### Flow

A flow is a directory `flows/<name>/` with `flow.yaml` and one Markdown instruction per step:

```
flows/feature/
  flow.yaml
  plan.md
  implement.md
  review.md
  finish.md
```

`stepan start feature <task>` reads `flows/feature/flow.yaml`; instruction paths are relative to
that directory.

```yaml
start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      plan:
        type: string
        required: true
    transitions:
      - to: implement

  implement:
    instruction: implement.md
    outcome:
      summary:
        type: string
    transitions:
      - to: review

  review:
    instruction: review.md
    outcome:
      verdict:
        type: enum
        values: [pass, fail]
        required: true
      findings:
        type: string
    transitions:
      - when: { verdict: fail }
        to: implement
      - when: { verdict: pass }
        to: finish

  finish:
    instruction: finish.md
```

`review` reports `verdict: pass` when the change is accepted and `verdict: fail` with `findings`
when it needs rework; a failed review goes back to `implement`.

- **Outcome field** — `type: string` or `type: enum` with non-empty string `values`;
  `required: true` when the field must be present and non-empty. Numbers, booleans and nested
  objects do not exist in an outcome.
- **Transition** — `to` and an optional `when: { field: value }` with exactly one field.
  Transitions are tried in order; the first whose condition matches is taken. At most one
  transition has no `when`: it is the default, it is optional, and it must be last.
- **Final step** — a step without transitions. `next` on it finishes the run. Cycles are allowed.
- **Placeholders** — `{{task}}` and `{{steps.<id>.outcome.<field>}}` in an instruction are
  replaced before it is printed, using these exact forms without spaces inside the braces.
  A placeholder that cannot be resolved stays as it is; a stored empty string replaces it with
  empty text. Substitution runs once: task and outcome values are data rather than nested
  templates. The snapshot keeps the original instruction text; substitution only affects output.
- **Names** — a step id and an outcome field name start with an ASCII letter and continue with
  ASCII letters, digits, `-` or `_`. A step id is a positional argument and a placeholder segment;
  an outcome field name is a CLI flag and a placeholder segment.

`start` validates the flow before it writes anything:

- `flow.yaml` exists and parses; `start` and a non-empty `steps` are present;
- `start` names a step and every `to` names a step;
- every step id and outcome field name follows the name rule;
- every step has a readable `instruction` file;
- `outcome` and `transitions` are optional; an empty or null `outcome` and an empty `transitions`
  are the same as none;
- an outcome field has a `type` (`string` or `enum`), non-empty string `values` only for `enum`,
  and `required` only as a boolean;
- a `when` names one field of its own step and its value fits that field;
- at most one transition has no `when`, and it is last;
- no key is unknown.

A refused flow says what is wrong and, when there is a step or a key, names it.

### Run

- One run per directory.
- The run file is `.stepan/run.json` under the write root from
  [docs/development.md](./docs/development.md): a test's temporary directory, `.dev-data/` when
  run from sources, the project directory for an installed package.
- The file holds:

  - `version` — the run file format, `1`;
  - `task` — the string from `start`;
  - `step` — the current step id;
  - `finished` — whether the run is over;
  - `flow` — the snapshot: the start step and every step's instruction text, outcome schema and
    transitions;
  - `outcomes` — the latest outcome of every step visited.

- `start` snapshots the graph and every instruction text into the run file. Editing the YAML or a
  Markdown file mid-run changes nothing.
- `start` while a run is live refuses and leaves the run untouched. A finished run is replaced.
- A run file that cannot be read or has an unknown `version` is an error for `start`, `current`
  and `next`; `start` never overwrites it. `abort` deletes it.
- A step visited again replaces its outcome; an instruction sees the latest one.
- Surviving `git clean` is out of 0.1 — see Open questions.

### Commands

| Command                                | Does                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `stepan start <flow> <task>`           | validates the flow, writes the run, prints the graph and the start step |
| `stepan current`                       | prints the current step from the snapshot                               |
| `stepan next <step> --<field> <value>` | takes the current step's outcome and moves on                           |
| `stepan abort`                         | deletes the run                                                         |

- `<flow>` names a directory under `flows/` in the working directory: `stepan start feature` reads
  `flows/feature/flow.yaml`. `<task>` is any non-empty string kept in the run for `{{task}}`;
  Stepan does not resolve it against a tracker.
- **Graph overview** — a line per step: the step, each transition with the value that selects it,
  and `(final)` for a step without transitions.
- **`current`** — how a new session resumes after a restart or a compaction: the same step from
  the snapshot, placeholders filled.
- **Step output** — the instruction with placeholders filled, then the exit line: `stepan next`
  with the step and every outcome field — a required string as `--plan "<text>"`, an enum as
  `--verdict <pass|fail>`, an optional field in brackets. The line is a template, not a command to
  paste as is: the agent replaces the placeholders.
- **`next`** — `<step>` must be the current step: a mismatch is an error and the run stays. An
  unknown flag or a flag given twice is a usage error. A missing required field or a value outside
  an enum is refused with a message naming it; the run stays. A valid outcome is checked against
  the transitions; the first match is taken, the outcome is stored, and the target step is printed
  in the Step output format. A final step takes the outcome and finishes the run: that `next` call
  prints that the run is finished, and later `next` and `current` report the same (`current` exits
  0, `next` exits 1). If no transition matches, the command fails and the run is unchanged.
- **`next` arguments** — the step id comes first, followed by long outcome flags. Both
  `--field value` and `--field=value` work; use the latter for a value beginning with `-`.
  Standalone `stepan next --help` or `stepan next -h` prints usage without reading the run.
  After the step id, `help`, `h` and `version` are ordinary outcome field names, not reserved
  options. An unreadable run, a finished run or a mismatched step is reported before parsing
  outcome flags; otherwise malformed flags are usage errors.
- **`abort`** — deletes the run; without a run it is an error.
- Errors go to stderr and exit non-zero: 1 for a refused flow, a missing or unreadable run, a live
  run on `start`, a step that is not current, a bad outcome or no matching transition; 2 for wrong
  usage.

### Not in 0.1

Checks of any level, optional steps, `on_enter`/`on_leave` and the tracker, `stepan show`, harness
hooks, the transition log, round counters, `--mode`, several runs per directory, a step library,
an agent skill. Surviving `git clean` is open, not promised.

## After 0.1

None of this is built, and 0.1 makes no promise about it.

### Loop limit

A cycle is allowed, but not unbounded. The run counts how many times each step is entered; a step
has a `max_visits` limit, five by default, and a flow may raise it. A transition that would enter a
step over its limit does not move: the run stops for a human with the step and the limit named.
This is what keeps a review loop from running forever.

### Checks on `next`

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

The outcome carries what a check and a re-check need — the path to the plan, the id of the
reviewer instance — so the same reviewer can be asked again.

Level 3 waits for the first time a model lies about a green run.

### Optional steps

Not every task needs the whole flow. But the agent is an interested party: building its own
pipeline, it would first drop the reviewer that keeps it from saying "done". So:

- **required steps cannot be removed.** Code changed — there is a code review; commit only after
  green checks;
- **optional steps are skipped with a reason**, and where possible under a condition code can
  check;
- **what was skipped goes into the report to the human**, with the reason.

One graph with optional steps — not a set of flows per task type, not free assembly from a step
library.

### Tracker and harness

**The task tracker is only a reflection.** Stepan does not know about trackers: on entering and
leaving a step it runs shell commands from the YAML
(`on_enter: boardown task status {task} in-progress`). Another tracker, or none, is a different
line in the YAML.

**Keeping the agent on the flow.** A long step pushes the exit line far back, so a harness hook
backs it up: a stop hook refuses to let the session end while the run is not in a final state; a
hook after compaction calls `stepan current` and puts the step back into context.

**Transition log.** Time, step, outcome, round number — step durations without digging through
session logs.

**Run mode.** `--mode interactive|auto`: a stop either asks in chat or ends the run with
`needs-answer`.

**`stepan show`.** Renders the graph as Mermaid.

### Not planned yet

- a step library with per-project overrides — until a second flow needs a step of the first;
- free assembly of the pipeline by the model.

## Open questions

- How a step learns whether code changed and whether the diff touches UI — general rules or per
  project.
- How the run file survives `git clean`.
