# CLAUDE.md

## Project

Stepan is a CLI for agent workflows: the agent pulls the next step of a flow inside its own
session, Stepan holds the graph, validates outcomes and runs checks. Open source, MIT, published
as `@grinev/stepan`. What it is and how it behaves — [PRODUCT.md](./PRODUCT.md); read it before
any non-trivial change. Early development: most of PRODUCT.md is not built yet, do not take it
for existing behaviour.

**Language.** Reply in the language the user wrote in. Everything committed — code, comments,
docs, commit messages, CLI output — is English.

## Stack

TypeScript strict, Node.js 22+, ESM, a single npm package without a bundler — `tsc` to `dist/`.
Vitest, ESLint (typescript-eslint, strict type-checked), Prettier. Runtime dependencies are added
one by one, when a task needs one.

## Main rule

**The core — flows, run state, outcomes, checks — knows nothing about task trackers or agent
harnesses.** A tracker is reached only through shell commands declared in the flow; harness
integrations (hooks, plugins) are a thin edge that calls the same CLI. This keeps Stepan usable
with any tracker and any harness that has a shell.

## Always

- Before code review and before a commit — `npm run check`; not before plan review. Write the
  output of every run whole to a file in the session scratchpad (`npm run check > <file> 2>&1`),
  no `tail`/`grep` in the same command; investigate from that file instead of re-running. A test
  that failed and passed on retry is flaky — find and fix it.
- User-visible behaviour gets an e2e test through `runCli`; logic with a real branch gets a unit
  test next to it — `docs/development.md`, "Tests".
- Anything Stepan writes — run state, config, hooks in Claude Code or OpenCode — follows the table
  in `docs/development.md`, "Where Stepan writes": a run from sources or a test never touches the
  maintainer's real settings and installed hooks.
- Windows works natively, not only under WSL — `docs/development.md`, "Platforms".

## Where things are

Read what applies **before** the work it concerns.

- **What Stepan does, commands, outcomes, checks** → `PRODUCT.md`.
- **Commands, tests, write locations, platforms** → `docs/development.md`.
- **Public introduction** → `README.md`; update it when user-facing behaviour changes.
- **Agents** `plan-reviewer`, `code-reviewer` — when they are called, in "How we work".

## How we work

- **Work starts with a plan in a file**, not plan mode: write it, run `plan-reviewer`, show it to
  the user and wait for agreement. Without a plan — only a quick fix the user explicitly asks for.
- **Plan structure.** Every plan consists of exactly four top-level sections: goal and scope,
  decisions, implementation, and verification. Goal and scope define the result and boundaries;
  decisions explain the chosen approach; implementation describes code and documentation changes;
  verification describes tests and acceptance checks. Keep all plan content within these sections.
- **Plan updates.** Update the relevant sections in the same file when accepted review feedback,
  implementation discoveries or user decisions change the scope, behaviour, approach or
  verification. Make the update when the decision is adopted, so the plan describes the current
  agreed solution and how to verify it. After code review, update the plan when addressing findings
  changes that solution or its verification.
- **Subagents are regular steps of the loop; call them yourself, without asking.** The permission
  is given here and always holds:
  - `plan-reviewer` — after the plan is written, before code. No code until the plan review has
    passed;
  - `code-reviewer` — after the implementation and a green `npm run check`; pass the task
    description, the path to the plan and the path to the check log.

  You decide on and fix their findings. Re-checks go to the same instance (`SendMessage`).

- **Plans are not committed**, so a reason from the plan that matters after the task — why this
  format, why not the obvious alternative — goes into the relevant doc before `code-reviewer`,
  as a short "why" next to the decision. Only for choices that would look strange without it.
- **The summary comes when every subagent has returned** and its findings are closed.
- **Commits** — only when the user asks. Asked to commit work that is not finished — stop and ask
  whether to commit now or finish first.
- Hold to the requested scope; raise adjacent issues instead of solving them silently. Propose a
  library, a storage format or a module boundary before implementing it. When behaviour described
  in `PRODUCT.md`, `README.md` or `docs/` changes, update them in the same change.
- **Keep this file short — about 150 lines.** Do not add sections: new knowledge goes into a doc,
  an agent file or a skill, here at most a line. On your own you may fix what is outdated and add
  a line to "Where things are" or "Always". A new section, an expanded rule or growth well past
  150 lines — only with the user's agreement.
