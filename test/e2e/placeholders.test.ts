import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunState } from '../../src/run.js';
import { createCli, runCli, type CliSandbox } from './run-cli.js';

const FLOW = `start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      path: {type: string, required: true}
      note: {type: string}
    transitions:
      - to: review
  review:
    instruction: review.md
    outcome:
      verdict: {type: enum, values: [pass, fail], required: true}
    transitions:
      - when: {verdict: fail}
        to: plan
      - to: finish
  finish:
    instruction: finish.md
`;
const INSTRUCTIONS = {
  plan: 'Plan {{task}}. Previous: {{steps.plan.outcome.path}}.\n',
  review: 'Review {{task}}: {{steps.plan.outcome.path}}.\nNote: {{steps.plan.outcome.note}}.\n',
  finish: 'Finish {{task}}: {{steps.review.outcome.verdict}}.\n',
};
const TASK = 'STP-5: задача';

function fixture(
  flow: string,
  instructions: Record<string, string>,
  layout: 'installed' | 'sources' = 'installed',
): CliSandbox {
  const cli = createCli(layout);
  const directory = join(cli.cwd, 'flows/feature');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'flow.yaml'), flow);
  for (const [id, text] of Object.entries(instructions))
    writeFileSync(join(directory, `${id}.md`), text);
  return cli;
}

function readRun(cli: CliSandbox): RunState {
  return JSON.parse(readFileSync(cli.runPath, 'utf8')) as RunState;
}

function success(cli: CliSandbox, args: string[], stdout: string): void {
  const result = runCli(args, cli);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(stdout);
  expect(readdirSync(dirname(cli.runPath))).toEqual(['run.json']);
}

function current(cli: CliSandbox, stdout: string): void {
  const before = readFileSync(cli.runPath, 'utf8');
  success(cli, ['current'], stdout);
  expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
}

function planOutput(path = '{{steps.plan.outcome.path}}'): string {
  return `Plan ${TASK}. Previous: ${path}.\n\nstepan next plan --path "<text>" [--note "<text>"]\n`;
}

function reviewOutput(path: string, note = '{{steps.plan.outcome.note}}'): string {
  return `Review ${TASK}: ${path}.\nNote: ${note}.\n\nstepan next review --verdict <pass|fail>\n`;
}

describe('instruction placeholders', () => {
  it.each(['installed', 'sources'] as const)(
    'renders task and latest outcomes from the unchanged %s snapshot',
    (layout) => {
      const cli = fixture(FLOW, INSTRUCTIONS, layout);
      success(
        cli,
        ['start', 'feature', TASK],
        `plan -> review\nreview -> verdict="fail" -> plan, finish\nfinish (final)\n\n${planOutput()}`,
      );
      const snapshot = readRun(cli).flow;
      for (const [id, text] of Object.entries(INSTRUCTIONS)) {
        expect(snapshot.steps[id]?.instruction).toBe(text);
      }
      current(cli, planOutput());

      const directory = join(cli.cwd, 'flows/feature');
      writeFileSync(join(directory, 'flow.yaml'), 'changed: true');
      writeFileSync(join(directory, 'plan.md'), 'Changed instruction.');
      writeFileSync(join(directory, 'review.md'), 'Changed review.');
      current(cli, planOutput());
      expect(existsSync(join(cli.cwd, 'docs/first plan.md'))).toBe(false);
      success(
        cli,
        ['next', 'plan', '--path', 'docs/first plan.md', '--note', 'old note'],
        reviewOutput('docs/first plan.md', 'old note'),
      );
      current(cli, reviewOutput('docs/first plan.md', 'old note'));
      success(cli, ['next', 'review', '--verdict=fail'], planOutput('docs/first plan.md'));

      rmSync(join(cli.cwd, 'flows'), { recursive: true });
      success(
        cli,
        ['next', 'plan', '--path', 'docs/second plan.md'],
        reviewOutput('docs/second plan.md'),
      );
      current(cli, reviewOutput('docs/second plan.md'));
      expect(readRun(cli).outcomes).toEqual({
        plan: { path: 'docs/second plan.md' },
        review: { verdict: 'fail' },
      });
      success(
        cli,
        ['next', 'review', '--verdict=pass'],
        `Finish ${TASK}: pass.\n\nstepan next finish\n`,
      );
      expect(readRun(cli).flow).toEqual(snapshot);

      const other =
        layout === 'sources' ? join(cli.cwd, '.stepan') : join(cli.packageRoot, '.dev-data');
      expect(existsSync(other)).toBe(false);
      for (const path of ['.stepan', '.config', 'AppData', '.local']) {
        expect(existsSync(join(cli.sandbox, path))).toBe(false);
      }
    },
  );

  it('inserts literal multiline data and empty strings once while leaving unknown references intact', () => {
    const instruction =
      'Task: {{task}}\nValue: {{steps.loop.outcome.value}}\nEmpty: [{{steps.loop.outcome.empty}}]\nUnknown: {{unknown}} / {{steps.missing.outcome.value}} / {{steps.loop.outcome.absent}}\n';
    const cli = fixture(
      `start: loop
steps:
  loop:
    instruction: loop.md
    outcome:
      value: {type: string, required: true}
      empty: {type: string}
    transitions:
      - to: loop
`,
      { loop: instruction },
    );
    const task = '{{steps.loop.outcome.value}} $& $1 $$ \\ "задача"';
    const value = '{{task}} $& $1 $$ \\ "план"\nsecond line';
    const exit = 'stepan next loop --value "<text>" [--empty "<text>"]\n';
    const unknown =
      'Unknown: {{unknown}} / {{steps.missing.outcome.value}} / {{steps.loop.outcome.absent}}\n';
    success(
      cli,
      ['start', 'feature', task],
      `loop -> loop\n\nTask: ${task}\nValue: {{steps.loop.outcome.value}}\nEmpty: [{{steps.loop.outcome.empty}}]\n${unknown}\n${exit}`,
    );
    const output = `Task: ${task}\nValue: ${value}\nEmpty: []\n${unknown}\n${exit}`;
    success(cli, ['next', 'loop', '--value', value, '--empty='], output);
    current(cli, output);
    expect(readRun(cli).outcomes.loop).toEqual({ value, empty: '' });
    expect(readRun(cli).task).toBe(task);
    expect(readRun(cli).flow.steps.loop?.instruction).toBe(instruction);
  });

  it('keeps placeholder-like enum values literal in the graph, exit template and inserted outcome', () => {
    const instruction = 'Task {{task}}; last {{steps.choose.outcome.verdict}}.';
    const cli = fixture(
      `start: choose
steps:
  choose:
    instruction: choose.md
    outcome:
      verdict: {type: enum, values: ['{{task}}', done], required: true}
    transitions:
      - when: {verdict: '{{task}}'}
        to: choose
      - to: finish
  finish:
    instruction: finish.md
`,
      { choose: instruction, finish: 'Finish {{task}}.' },
    );
    const exit = 'stepan next choose --verdict <{{task}}|done>\n';
    success(
      cli,
      ['start', 'feature', 'TASK-5'],
      `choose -> verdict="{{task}}" -> choose, finish\nfinish (final)\n\nTask TASK-5; last {{steps.choose.outcome.verdict}}.\n\n${exit}`,
    );
    const output = `Task TASK-5; last {{task}}.\n\n${exit}`;
    success(cli, ['next', 'choose', '--verdict', '{{task}}'], output);
    current(cli, output);
    expect(readRun(cli).flow.steps.choose?.instruction).toBe(instruction);
  });
});
