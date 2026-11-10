# Stepan — product

What Stepan is and how it behaves. This file describes the current intent; it is not a gate. A
change that goes beyond it updates it in the same change.

**State:** 0.1 is specified below; `install`, `start`, `current`, `next`, `rm`, `runs`, independent
run IDs, execution history and instruction placeholder substitution are implemented.
Checks and hooks are not.

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

The first release installs and walks independent flows: `install`, `start`, `current`, `next`, `rm`, `runs`.
No checks, no hooks, no tracker. This section is the contract; code follows it, not a chat.

### Flow

A flow is a directory `.stepan/flows/<name>/` with `flow.yaml` and one Markdown instruction per step:

```
.stepan/flows/feature/
  flow.yaml
  steps/
    plan.md
    implement.md
    review.md
    finish.md
```

`flow.yaml` stays in the flow root so the definition is the one file there. Instructions live in
`steps/` rather than beside it: a flow has many of them, and the root should not mix the graph
with step text. `stepan start feature <task>` reads `.stepan/flows/feature/flow.yaml`; instruction
paths such as `steps/plan.md` are relative to that directory, with no separate lookup.

Flow definitions and run state share `.stepan/` so Stepan does not reserve a generic top-level
`flows/` directory. Commit `.stepan/flows/`; add only `.stepan/runs/` to `.gitignore`, not all of
`.stepan/`. Flow input always comes from the working directory, with no global lookup or fallback
to a top-level `flows/` directory.

```yaml
description: Implement a change, review it, and finish when the review passes.
start: plan
steps:
  plan:
    instruction: steps/plan.md
    outcome:
      plan:
        type: string
        required: true
    transitions:
      - to: implement

  implement:
    instruction: steps/implement.md
    outcome:
      summary:
        type: string
    transitions:
      - to: review

  review:
    instruction: steps/review.md
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
    instruction: steps/finish.md
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
  A syntactically valid outcome reference with no stored value prints `-`, including an unknown
  step or field. The visible marker distinguishes missing data from a stored empty string, which
  prints as empty text; a stored `-` looks the same as the marker. Unknown or malformed
  placeholders stay literal. Substitution runs once: task and outcome values are data rather
  than nested templates. Substitution only affects output, not project instruction files.
- **Names** — a step id and an outcome field name start with an ASCII letter and continue with
  ASCII letters, digits, `-` or `_`. A step id is a graph key and a placeholder segment;
  an outcome field name is a CLI flag and a placeholder segment.
- **Description** — optional string explaining the flow's purpose, approach and result boundary
  to the agent. It may be multiline or empty and is printed literally at `start`, without
  instruction placeholder substitution.

`start` validates the flow before it writes anything:

- `flow.yaml` exists and parses; `start` and a non-empty `steps` are present;
- `description`, when present, is a string;
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

### Installing flows

`stepan install <source> [--flow <name>] [--ref <branch|tag|commit>]` copies flows
from Git into `<write root>/.stepan/flows/`. Git on PATH is required for install
only. Sources are GitHub `owner/repo`, full HTTPS/SSH Git URLs, SCP-style SSH
URLs and `file://` Git URLs; other protocols, plain paths and embedded passwords
are refused. Existing Git credential helpers may supply saved credentials, but
terminal/askpass prompts are disabled. SSH uses OpenSSH `ssh` on PATH with
BatchMode and strict host-key checking, retaining SSH config/agent/known hosts
but not custom `GIT_SSH*` wrappers or `core.sshCommand`.
Each Git subprocess has a 120-second timeout and
a 16 MiB output buffer limit; a larger response is an explicit failure.

- With no `--flow`, select every immediate flow directory in the source's
  `.stepan/flows/`; ignore ordinary files directly in the collection directory.
  With `--flow`, select one exact directory name. No collection or an unknown
  selection is an error. All selected definitions must be valid before copying.
- With no `--ref`, use the default branch. Otherwise resolve a branch, tag or
  commit present in the cloned repository. Commit prefixes must be hexadecimal
  and at least seven characters. Ambiguous branch/tag names require an explicit
  `refs/heads/` or `refs/tags/` prefix. Git revision expressions are not accepted.
- Read a single commit through a temporary bare clone, not checkout. Do not run
  hooks, checkout filters, submodules, scripts or instructions. Copy ordinary
  files inside selected flows only, never source runs or harness configuration.
  Preserve the Git executable flag on platforms with executable permissions.
  Refuse symlinks/gitlinks, path traversal, Windows-incompatible names and
  case-insensitive/Unicode-normalization path collisions. Installed instruction
  references must name files inside their own flow; this installation restriction
  does not change how manually authored project flows are loaded.
- An existing destination is an error, even if empty, a symlink, or different
  only by case. Do not follow symlinks/junctions in destination parents. Check
  the whole set before writing, reserve new flow directories exclusively, and
  never overwrite existing files. On ordinary copy failures, attempt rollback
  of only this invocation's new flow directories; report rollback failures.
  Empty parents may remain. Crash-atomicity and protection against hostile
  concurrent replacement of the project tree are not provided.
- Temporary clone/staging lives under `<write root>/.stepan/.install-<random>/`
  and is removed on success or ordinary failure. Report cleanup failures;
  a cleanup failure after successful copying may leave installed flows despite
  a non-zero exit. The temporary path in the error identifies what to inspect.
- Print source, resolved commit and destination paths on success. Do not store
  provenance, a lockfile or an update link. Definitions are editable local files
  suitable for Git; execution never needs the source or network access.
- Installation has the same write-root isolation as run state. From sources,
  it writes into `.dev-data/`; flow reads still use cwd, so running an example
  installed there requires changing cwd to `.dev-data/`.
- Invalid/missing/repeated options, unsupported source syntax, invalid ref/name
  syntax or extra positionals exit 2; Git source retrieval,
  validation, path, conflict and I/O failures exit 1. Standalone `install --help`
  and `install -h` perform no filesystem or Git access.

There are no built-in flows, global installs, automatic updates or catalog search.
The example lives in https://github.com/grinev/stepan-flows. Validation establishes
format and file boundaries, not trust: third-party instructions must be reviewed
before being given to an agent.

### Run

- One session drives a run; several independent runs can coexist in one working directory.
  Stepan isolates run state, not working-tree changes: use worktrees when code changes need
  isolation. Managing the same run from multiple sessions is not the intended workflow.
- A run ID is eight lowercase hex characters, such as `a7c93f2b`, generated from four random
  bytes. A collision retries with a new ID without overwriting anything; ten consecutive
  collisions are an error. IDs are used in full, with no abbreviations or implicit latest run:
  parallel sessions must not accidentally advance each other's runs.
- Each run file is `.stepan/runs/<run-id>.json` under the write root from
  [docs/development.md](./docs/development.md): a test's temporary directory, `.dev-data/` when
  run from sources, the project directory for an installed package.
- The file holds:

  - `version` — the run file format, `2`, not a flow revision;
  - `id` — the run ID, matching the filename;
  - `flowName` — the flow name from `start`, for listing;
  - `task` — the string from `start`;
  - `events` — the ordered execution history, using the shapes below.

- The header and `events` are the only stored fields. Current step, finished status and latest
  outcomes are derived from history, not stored again. No graph, description, instruction text,
  outcome schema, visit counter or duration is stored. JSON is a machine-readable record; manual
  editing and append-only storage are not requirements.
- Event shapes (all keys shown are required; unknown keys are rejected):

  | `type`         | Other fields                  | Meaning                                     |
  | -------------- | ----------------------------- | ------------------------------------------- |
  | `started`      | `at`, `step`                  | enter the initial step                      |
  | `transitioned` | `at`, `from`, `to`, `outcome` | complete one visit and enter the next       |
  | `finished`     | `at`, `step`, `outcome`       | complete the final visit and finish the run |

  `at` is an ISO 8601 UTC system-clock timestamp with milliseconds, for example
  `2026-11-05T10:00:00.000Z`. Array order is authoritative: equal or decreasing timestamps are
  allowed because the system clock can change. Intervals describe wall-clock time, not active
  agent work. Step and outcome field names follow the step/field name rule above;
  `outcome` is an object of string values, including `{}` when no fields were supplied.

- History starts with exactly one `started`. Each `from` or finishing `step` equals the current
  step derived from earlier events. At most one `finished` is allowed, with no events after it.
  Self-transitions and repeated visits are separate events. Only successful `start` and `next`
  add events; reads, failed commands and rejected outcomes do not.
- Active `current` and `next` read the entire current flow and its instructions from the working
  directory's project files. Missing files, invalid definitions or a removed current step cause
  an explicit error without changing the run. Valid instruction, schema, transition and start-step
  edits apply to future execution. No snapshot, hash check or automatic flow versioning is provided.
  A project can retain an old flow separately under another name.
- Past outcomes and transitions are not revalidated or replayed against today's graph. The file
  records what actually happened, so it remains readable after old steps, fields or edges change.
  The visited path is not the full historical graph: unvisited branches and old conditions cannot
  be reconstructed. A future UI can combine history with current project definitions, but an exact
  historical graph is not promised.
- `start` always creates a separate run, including for the same flow and task. Existing active
  and finished runs are retained, unchanged. Finishing a run does not delete it.
- A selected run file that cannot be read or has an unsupported `version` is an error for `current`
  and `next`. `runs` also reports unreadable or invalid run files instead of silently hiding them.
  `rm` can delete a file without parsing it. Version 1 is unsupported; no automatic migration or
  rewriting is performed. An unrelated old or damaged run does not block `start`.
- Every completed visit retains its outcome in history. Instructions see the latest completed
  visit's outcome, replacing all prior fields rather than merging them. Entering a step again
  does not erase its previous completed outcome.
- Surviving `git clean` is out of 0.1 — see Open questions.

### Commands

| Command                                                 | Does                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `stepan install <source> [--flow <name>] [--ref <ref>]` | installs project flows from a Git commit                         |
| `stepan start <flow> <task>`                            | creates a run, prints its description, ID and first instruction  |
| `stepan current <run-id>`                               | prints the selected run's current instruction from project files |
| `stepan next <run-id> --<field> <value>`                | takes the selected run's current outcome and moves on            |
| `stepan rm <run-id>`                                    | deletes the selected run                                         |
| `stepan runs`                                           | lists active runs                                                |
| `stepan runs --all`                                     | lists active and retained finished runs                          |

- `<flow>` names a directory under `.stepan/flows/` in the working directory: `stepan start feature`
  reads `.stepan/flows/feature/flow.yaml`. `<task>` is any non-empty string kept in the run for `{{task}}`;
  Stepan does not resolve it against a tracker.
- **`start` output** — the optional nonempty description, then the first step output. No graph
  is printed, even without a description: the agent needs the current instruction, not the
  transition graph. `current` and `next` do not repeat the description.
- **Run selection** — `current`, `next` and `rm` require a valid run ID; omission or an invalid
  ID is a usage error. They never guess a run from its task, flow, recency or harness session.
- **`current`** — how a session resumes after a restart or a compaction: the same step from
  the selected run's history, with the current project instruction and placeholders filled.
  Use `runs` to recover a forgotten ID.
- **Step output** — `Run: <run-id>` and `Step: <step-id>`, the instruction with placeholders
  filled, then the exit line: `stepan next` with the actual run ID already filled in and every
  outcome field — a required string as `--plan "<text>"`, an enum as
  `--verdict <pass|fail>`, an optional field in brackets. The line is a template, not a command to
  paste as is: the agent replaces outcome placeholders, not the run ID.
- **`next`** — the current step is taken from the selected run's state, not a CLI argument. An
  unknown flag or a flag given twice is a usage error. A missing required field or a value outside
  an enum is refused with a message naming it; the run stays. A valid outcome is checked against
  the transitions; the first match is taken, the outcome is stored, and the target step is printed
  in the Step output format. A final step takes the outcome and finishes the run: that `next` call
  prints `Run <run-id> is finished.`, and later `next` and `current` report the same (`current` exits
  0, `next` exits 1), without loading the flow. If no transition matches, the command fails and
  the run is unchanged. The selected transition and its outcome are appended to history; a
  final step appends `finished` with its outcome. Flow loading, outcome parsing, transition
  selection and output preparation happen before saving, using one loaded flow under the run lock.
- **`next` arguments** — the run ID comes first, followed by long outcome flags. Both
  `--field value` and `--field=value` work; use the latter for a value beginning with `-`.
  Standalone `stepan next --help` or `stepan next -h` prints usage without reading the run.
  After the run ID, `help`, `h` and `version` are ordinary outcome field names, not reserved
  options. An unreadable run or a finished run is reported before parsing
  outcome flags; otherwise malformed flags are usage errors.
- **`rm`** — deletes the selected active or finished run, including damaged JSON or an unknown
  version; reports `Run <run-id> deleted.`. A missing run is an error. Other runs are unchanged.
  Deleted runs do not appear in either listing.
- **`runs`** — prints ID, flow, task, current step and status (`active` or `finished`), sorted by
  ID. The table has a header and tab-separated JSON-quoted cells, escaping multiline values so
  each run takes one row. Empty lists print `No active runs.` or `No runs.` with exit code 0.
  `--all` includes finished runs; the table does not display history. Listing needs only run files,
  not flow definitions. Lock files are ignored.
- Errors go to stderr and exit non-zero: 1 for a refused flow, a missing or unreadable run,
  a busy lock, an I/O failure, ID allocation failure, a bad outcome or no matching transition;
  2 for wrong usage, including an absent or invalid run ID or an extra positional step.

### Not in 0.1

Checks of any level, optional steps, `on_enter`/`on_leave` and the tracker, `stepan show`, harness
hooks, a history-viewing command, round counters, `--mode`, a step library,
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
hook after compaction calls `stepan current <run-id>` and puts the step back into context.
The thin integration must supply the session's run ID; core does not bind runs to harness sessions.

**History display.** A dedicated view of recorded transitions and wall-clock intervals, without
digging through run files or session logs. Transition timestamps and outcomes are already stored;
round counters are not implemented.

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
