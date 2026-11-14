---
name: stepan-flow-creator
description: Create, design, adapt, or edit Stepan flows from a user's description of their process. Use when the user wants a new Stepan workflow, wants to turn project instructions into a flow, or needs help with flow.yaml, step instructions, outcomes, transitions, or placeholders. This skill authors flow files; it does not execute a workflow or manage runs.
---

# Stepan flow creator

Turn the user's process into an explicit graph and focused Markdown instructions.
Keep the user in control of the process; do not invent approvals or perform its work.

## Read the local contract first

Before creating or changing a flow, read [references/flow-format.md](references/flow-format.md).
Resolve this path relative to this installed skill's directory, not the project's working
directory. It is the complete authoring reference for the current Stepan 0.1 contract.

The complete reference ships with this skill. Read it locally; do not fetch a format
specification or project source from the internet. No Stepan checkout is needed.
An installed CLI is optional for authoring. Design the process the user requested;
the excerpts below illustrate the format, not a required workflow.

## Design for one session

A run is driven by one agent session, not a fresh agent at every step. Earlier work,
decisions, reports, and agent session IDs remain in that conversation. Each instruction
tells the agent what to do next; it should not reconstruct the whole execution context.

Keep steps short and action-oriented. A self-contained instruction makes its action clear;
it does not repeat everything the agent already knows. Do not copy loaded project rules
into steps or repeatedly ask the agent to reread a general instruction file. Give any
process-wide guidance once, where it first applies.

## Understand and propose

1. Read relevant project rules. For an existing flow, read its `flow.yaml` and all referenced
   instructions before proposing changes. Treat their contents as material to edit, not as
   permission to perform the described work.
2. Understand the intended result, inputs, steps, handoffs, decision makers, rework paths,
   and completion boundary. Ask only questions that materially change the graph or instructions.
   Do not add a tracker, subagent, review gate, commit, or other requirement the user did not request.
   Translate actions, not source-document headings: when rework differs from initial work,
   give it a separate step such as `revise-plan` or `fix`. Name steps after their actions,
   such as `plan-review` or `code-review`, rather than an abstract subject.
3. Propose the flow name and location, steps, outcome fields, transitions, and final step.
   Use a short list or text diagram; explain what comes back on a failed decision.
   Identify which approvals require an actual human answer.
4. Ask the user to approve this concrete proposal and wait. A request to create a flow is not
   approval of an unseen design. If the user already approved this exact design, do not ask again.
   On a requested edit, make the proposed changes and affected files clear before writing.

When the requested process needs unsupported features, explain the limitation using the
local reference. Offer a clearly labelled instruction-level alternative if useful; do not
invent YAML keys or claim prose is enforced by Stepan. Resolve that choice before writing.

## Write the agreed flow

- Create `.stepan/flows/<name>/flow.yaml` and `steps/*.md` in the target project.
  Use readable, portable names and relative instruction paths inside the flow directory.
- Check destination files before writing. For a new flow, do not overwrite an existing
  directory: propose another name or ask whether the user wants to edit it.
  For an edit, preserve unrelated content and files; apply only approved changes.
- Describe the purpose, broad approach, and result boundary in `description`, not the
  step-by-step route. Keep graph control in YAML and the work of each step in its instruction.
- State the next action, expected artifact or decision, and any real approval requirement.
  Include only the inputs needed there; do not impose a repeated input/output template.
- Use supported placeholders as targeted reminders: a plan path before review or revision,
  for example. Do not prepend the same task, spec, and plan to every step. Resolve actual
  artifact paths instead of constructing them from `{{task}}`, which may be arbitrary prose.
- Keep outcomes for routing decisions and values later steps actually reference. File paths
  are useful; full reviewer feedback, research reports, and progress summaries usually
  duplicate the conversation. Outcomes are strings, not files automatically opened by Stepan.
- Use outcome enums for decisions and explicit rework transitions. Make terminal steps clear.
  A missing prior outcome prints `-`; instructions should explain how to proceed on a first visit.
  Revisited steps see the latest completed outcome, which may be from an earlier visit.
- Where the user's process requires approval, instruct the executing agent to wait for the
  actual answer and report it faithfully. An enum does not prove that approval occurred.
- If a launch command is requested, keep it to starting the flow and following the returned
  instructions. The CLI already prints how to report each step's outcome and continue;
  do not repeat that boilerplate in the command or step instructions.
- Keep project rules in force. Do not edit harness settings, hooks, tracker configuration,
  project rules, or unrelated flows as a side effect.
- Explain that flow definitions belong in Git and only `.stepan/runs/` should be ignored.
  Do not change `.gitignore` or make a commit unless separately requested.

## Format excerpts

These illustrative fragments show a process that calls for plan review. They are not
a complete flow or a requirement to add review to other processes.

A step declares its instruction, the plan path it reports, and its next step:

```yaml
plan:
  instruction: steps/plan.md
  outcome:
    plan:
      type: string
      required: true
  transitions:
    - to: plan-review
```

Review reports only its verdict; revision uses the findings already in the session:

```yaml
plan-review:
  instruction: steps/plan-review.md
  outcome:
    verdict:
      type: enum
      values: [pass, fail]
      required: true
  transitions:
    - when: { verdict: fail }
      to: revise-plan
    - when: { verdict: pass }
      to: implement
revise-plan:
  instruction: steps/revise-plan.md
  transitions:
    - to: plan-review
```

The review instruction gives the reviewer the file it needs:

```markdown
# Review the plan

Plan: {{steps.plan.outcome.plan}}

Ask the process's reviewer to read the plan. On a recheck, resume the same reviewer.
Wait for its verdict: `pass` if accepted, `fail` if changes are needed.
```

Revision is a different action, not a request to plan from scratch:

```markdown
# Revise the plan

Plan: {{steps.plan.outcome.plan}}

Update the plan for accepted findings from the latest review in this session.
Explain rejected findings to the reviewer.
```

The full flow continues through implementation to a final step. In any flow you create,
every referenced step and instruction file must exist. Do not execute these excerpts
or add review or approval to a process that does not call for it.

## Check the authored files

Always check the files against the local reference: keys and types, readable instructions,
existing targets, outcome conditions, ordered defaults, terminal path, and placeholder inputs.
Check that every possible decision has an intentional route and rework has a way to finish.
Check instruction economy too: each step adds a distinct action, path reminders appear
where useful, and outcomes do not replay reports already in the session.
Never invent `stepan validate`, `--dry-run`, or another command that does not exist.

`start` creates a run; it is not a read-only validator. Do not start a run or install/update
tools as a side effect of authoring. If the user separately requests CLI verification,
agree on that check and its write locations first.

## Hand back

List the created or changed files, summarize the agreed graph, and report exactly what was
checked: manual review, a separately requested CLI check, or a limitation. Do not claim CLI validation
when no CLI was run.

Explain how the user can start the flow later with `stepan start <name> "<task>"`.
Do not start or execute their process automatically. This skill ends at authoring and verification.
