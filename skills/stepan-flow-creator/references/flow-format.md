# Stepan flow format — 0.1

This is a self-contained reference bundled with `stepan-flow-creator`. It describes the
implemented 0.1 contract, not proposed features. Read it locally before authoring or editing.

## Location and files

```text
.stepan/flows/<name>/
  flow.yaml
  steps/
    plan.md
    approve-plan.md
    implement.md
    finish.md
```

The working directory determines the project. There is no global flow lookup.
`stepan start <name> "<task>"` reads `.stepan/flows/<name>/flow.yaml`.
Every `instruction` path is relative to that flow's directory.
Commit `.stepan/flows/`; ignore only `.stepan/runs/`, not all of `.stepan/`.

Use portable directory names and filename stems: ASCII letters, digits, hyphens and underscores,
starting with a letter; avoid Windows device names such as `CON`, `NUL`, `COM1`, `LPT1`,
trailing dots/spaces, and names differing only by case. This is an authoring convention
for portable, distributable files, not the validator's rule for every filesystem path.
Use `/` in relative paths and keep every instruction inside its own flow.

## YAML and allowed keys

The root is a mapping with only these keys:

| Key           | Required | Value                                                         |
| ------------- | -------- | ------------------------------------------------------------- |
| `description` | no       | String describing the purpose, approach, and result boundary. |
| `start`       | yes      | ID of an existing step.                                       |
| `steps`       | yes      | Non-empty mapping of step IDs to step definitions.            |

Each step is a mapping with only:

| Key           | Required | Value                                              |
| ------------- | -------- | -------------------------------------------------- |
| `instruction` | yes      | String path naming a readable instruction file.    |
| `outcome`     | no       | Mapping of outcome field names to schemas (below). |
| `transitions` | no       | Ordered array of transitions (below).              |

All mapping keys must resolve to strings and be unique, including keys supplied by aliases.
Non-string/complex keys, duplicate keys, unknown keys, parser errors and warnings are rejected.
Use plain mappings and sequences rather than tags, merge keys, or elaborate aliases.
YAML core typing applies: quote strings that look like booleans, numbers, or null.
For example, use enum `values: ["true", "false"]`, not `[true, false]`.

`description` can be multiline or empty, but not null. It is printed literally at `start`;
placeholders are not expanded there. It is not repeated by `current` or `next`.

Step IDs and outcome field names match `[A-Za-z][A-Za-z0-9_-]*`.
They are case-sensitive; use the exact spelling in transitions and placeholders.
This rule applies to graph/field identifiers, not Markdown headings.

## Outcome schemas and reported values

```yaml
outcome:
  decision:
    type: enum
    values: [approved, changes]
    required: true
  feedback:
    type: string
```

- Only `type`, `required`, and (for enums) `values` are allowed in a field schema.
- `type` must be `string` or `enum`. There are no numbers, booleans, objects, or arrays as
  reported outcome values. A file path is just a string; Stepan does not open that file.
- An enum requires a non-empty array of non-empty strings in `values`.
  A string schema must not have `values`.
- `required`, if present, is a boolean. With `required: true`, a reported value must exist
  and be non-empty. Whitespace is not automatically trimmed.
- Optional string fields may be omitted or contain `""`; an optional enum can be omitted,
  but a supplied value must still belong to its enum.
- Omitted, null, and empty-map `outcome` are equivalent: no fields.

The executing agent reports fields as flags to `stepan next <run-id>`, for example
`--decision changes --feedback "Clarify the scope."`. Reported values are strings.
Unknown fields, repeated flags, missing required fields and invalid enum values are refused.
Both `--field value` and `--field=value` work; use `--field=value` for values starting with `-`.
After the run ID, `--help` is an ordinary outcome flag if the schema declares `help`.

## Transitions and completion

```yaml
transitions:
  - when: { decision: changes }
    to: plan
  - when: { decision: approved }
    to: implement
```

- Each transition allows only required string `to` and optional mapping `when`.
  Every `to` must name an existing step.
- `when` has exactly one field, declared in this same step's outcome schema.
  Its expected value is a string that fits the field's schema.
  It cannot refer to another step, compare two fields, or express AND/OR.
- Transitions are evaluated in array order. The first matching condition wins.
  Missing outcome fields do not match, including a condition expecting `""`.
- A transition without `when` is a default. There can be at most one and it must be last.
  A default is optional. Without a match or default, `next` fails without advancing.
- Omitted or empty-array `transitions` makes a step final. Null is not an array and is rejected.
  The final step still has work: entering it does not finish the run. Reporting it with
  `next` completes the run, including when there are no outcome fields.
- Cycles and self-transitions are allowed. There is no visit/round limit.
  Design a clear exit and explain when the agent must ask a human instead of repeating.
- A flow with only one final step is valid. Authoring should also check that the intended
  steps are reachable and every decision has an intentional path; schema validation alone
  does not establish these design properties.

Do not use an unconditional transition before a conditional one. Do not put a final step
behind an impossible condition. An enum is useful for explicit decisions; it does not
prove that a reviewer was called or that a user gave approval.

## Instruction placeholders

Only these exact forms are substituted in step instructions:

```text
{{task}}
{{steps.<step-id>.outcome.<field-name>}}
```

For a plan path, use `{{steps.plan.outcome.plan}}`. The excerpts in `../SKILL.md`
illustrate a path reminder before review and revision without repeating the review report.

- No spaces inside braces. Unknown or malformed forms remain literal.
- `{{task}}` is the non-empty task string supplied to `start`; Stepan does not resolve a tracker ID.
- Outcome references use the latest completed visit of the named step, not its current unfinished
  visit. A reference without a stored value prints `-`, including an unknown step or field.
  Check spelling yourself: the placeholder does not validate the graph reference for you.
- A saved empty string prints empty text. A saved literal `-` looks like the missing-value marker.
- A newly completed visit replaces all of that step's previously visible fields, not a merge.
  An omitted optional field no longer exposes its older value.
- Re-entering a step does not erase its previous completed outcome. On rework, make clear
  which values are from earlier visits. A first visit may have no prior review result.
- Substitution happens once. Task/outcome values containing placeholders stay data, not nested
  templates. Original instruction files are never rewritten.

Use placeholders for inputs needed by the next action, such as a file to read, edit, or pass
to a reviewer. A run continues in one agent session, so do not repeat the full context or
reports in every instruction. If a human decision is required, instruct the agent to ask
and wait; do not let it supply approval on the human's behalf.

## Boundaries and verification

`start` validates the entire flow and all instruction files before creating a run.
It checks schema keys/types, names, instruction readability, step targets and transition conditions.
It does not establish instruction safety, execution, human approval, or quality of work.
There is no `validate`, `lint`, or `--dry-run` command.

For manually authored local flows, the loader resolves `instruction` paths relative to the
flow directory but does not enforce that they stay inside it. For flows distributed through
`stepan install`, instruction references must stay inside their own flow; symlinks/gitlinks,
path traversal, Windows-incompatible names and case/Unicode-normalization collisions are refused.
Author self-contained ordinary files so they work in both cases.

Active runs read current project flow files, not a snapshot. Editing a flow can affect or break
an existing run. Do not advance, migrate, or repair real runs while authoring; flag relevant edits
to the user.

Not implemented: checks, hooks, optional-step mechanisms, `on_enter`/`on_leave`, visit counters,
`max_visits`, run modes, a step library, and graph-display or validation commands.
Do not generate keys for these. Shell commands can be written as instructions to the agent,
but Stepan does not automatically run them or verify their success.

This reference targets the implemented 0.1 format. If an installed CLI rejects it, report the
version and error; do not silently update the CLI or fetch a different specification.
Manual checking needs only these local files. `start` creates a run; do not use it as a
read-only validator. Any CLI verification is a separate action to agree with the user,
not permission to execute the authored process.
