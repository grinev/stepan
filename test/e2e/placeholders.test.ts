import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runView, type RunState } from '../../src/run.js';
import { createCli, runCli, runId, runPath, type CliSandbox } from './run-cli.js';

interface Fixture extends CliSandbox {
  id: string;
  runPath: string;
}

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
): Fixture {
  const cli = createCli(layout);
  const directory = join(cli.cwd, '.stepan/flows/feature');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'flow.yaml'), flow);
  for (const [id, text] of Object.entries(instructions))
    writeFileSync(join(directory, `${id}.md`), text);
  return { ...cli, id: '', runPath: '' };
}

function readRun(cli: Fixture): RunState {
  return JSON.parse(readFileSync(cli.runPath, 'utf8')) as RunState;
}

function success(cli: Fixture, args: string[], stdout: string): void {
  const result = runCli(args, cli);
  if (args[0] === 'start') {
    cli.id = runId(result);
    cli.runPath = runPath(cli, cli.id);
  }
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.replaceAll(cli.id, 'RUN-ID')).toBe(stdout);
  expect(readdirSync(cli.runsDirectory)).toEqual([`${cli.id}.json`]);
}

function current(cli: Fixture, stdout: string): void {
  const before = readFileSync(cli.runPath, 'utf8');
  success(cli, ['current', cli.id], stdout);
  expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
}

function planOutput(path = '-'): string {
  return `Run: RUN-ID\nStep: plan\n\nPlan ${TASK}. Previous: ${path}.\n\nstepan next RUN-ID --path "<text>" [--note "<text>"]\n`;
}

function reviewOutput(path: string, note = '-'): string {
  return `Run: RUN-ID\nStep: review\n\nReview ${TASK}: ${path}.\nNote: ${note}.\n\nstepan next RUN-ID --verdict <pass|fail>\n`;
}

describe('instruction placeholders', () => {
  it.each(['installed', 'sources'] as const)(
    'restores reviewer and report on revisits in %s mode',
    (layout) => {
      const instruction =
        'Reviewer: {{steps.review.outcome.reviewer}}\nReport: [{{steps.review.outcome.report}}]\n';
      const cli = fixture(
        `start: review
steps:
  review:
    instruction: review.md
    outcome:
      reviewer: {type: string, required: true}
      report: {type: string}
    transitions:
      - to: review
`,
        { review: instruction },
        layout,
      );
      const output = (reviewer: string, report: string): string =>
        `Run: RUN-ID\nStep: review\n\nReviewer: ${reviewer}\nReport: [${report}]\n\nstepan next RUN-ID --reviewer "<text>" [--report "<text>"]\n`;
      success(cli, ['start', 'feature', TASK], output('-', '-'));
      current(cli, output('-', '-'));
      expect(readFileSync(join(cli.cwd, '.stepan/flows/feature/review.md'), 'utf8')).toBe(
        instruction,
      );
      success(
        cli,
        ['next', cli.id, '--reviewer', 'ses_123', '--report', 'report.md'],
        output('ses_123', 'report.md'),
      );
      current(cli, output('ses_123', 'report.md'));
      success(cli, ['next', cli.id, '--reviewer', 'ses_123'], output('ses_123', '-'));
      success(cli, ['next', cli.id, '--reviewer', 'ses_123', '--report='], output('ses_123', ''));
      current(cli, output('ses_123', ''));
      expect(readRun(cli).events).toHaveLength(4);
      expect(readRun(cli).events[1]).toMatchObject({
        outcome: { reviewer: 'ses_123', report: 'report.md' },
      });
    },
  );

  it.each(['installed', 'sources'] as const)(
    'renders task and latest completed outcomes in %s mode',
    (layout) => {
      const cli = fixture(FLOW, INSTRUCTIONS, layout);
      success(cli, ['start', 'feature', TASK], planOutput());
      expect(readRun(cli)).not.toHaveProperty('flow');
      current(cli, planOutput());
      expect(existsSync(join(cli.cwd, 'docs/first plan.md'))).toBe(false);
      success(
        cli,
        ['next', cli.id, '--path', 'docs/first plan.md', '--note', 'old note'],
        reviewOutput('docs/first plan.md', 'old note'),
      );
      current(cli, reviewOutput('docs/first plan.md', 'old note'));
      success(cli, ['next', cli.id, '--verdict=fail'], planOutput('docs/first plan.md'));

      success(
        cli,
        ['next', cli.id, '--path', 'docs/second plan.md'],
        reviewOutput('docs/second plan.md'),
      );
      current(cli, reviewOutput('docs/second plan.md'));
      expect(runView(readRun(cli)).outcomes).toEqual({
        plan: { path: 'docs/second plan.md' },
        review: { verdict: 'fail' },
      });
      success(
        cli,
        ['next', cli.id, '--verdict=pass'],
        `Run: RUN-ID\nStep: finish\n\nFinish ${TASK}: pass.\n\nstepan next RUN-ID\n`,
      );
      expect(readRun(cli).events[1]).toMatchObject({
        outcome: { path: 'docs/first plan.md', note: 'old note' },
      });

      const other =
        layout === 'sources' ? join(cli.cwd, '.stepan/runs') : join(cli.packageRoot, '.dev-data');
      expect(existsSync(other)).toBe(false);
      for (const path of ['.stepan', '.config', 'AppData', '.local']) {
        expect(existsSync(join(cli.sandbox, path))).toBe(false);
      }
    },
  );

  it('inserts literal multiline data and empty strings once while marking missing outcomes', () => {
    const instruction =
      'Task: {{task}}\nValue: {{steps.loop.outcome.value}}\nEmpty: [{{steps.loop.outcome.empty}}]\nUnknown: {{unknown}} / {{steps.missing.outcome.value}} / {{steps.loop.outcome.absent}} / {{{steps.missing.outcome.value}}} / {{unknown {{steps.missing.outcome.value}} }}\nExample `{{task`\nCurrent: {{task}}\nJSON: {"value":{{steps.loop.outcome.value}}}\n';
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
    const exit = 'stepan next RUN-ID --value "<text>" [--empty "<text>"]\n';
    const extra = (value: string): string =>
      `Unknown: {{unknown}} / - / - / {{{steps.missing.outcome.value}}} / {{unknown {{steps.missing.outcome.value}} }}\nExample \`{{task\`\nCurrent: ${task}\nJSON: {"value":${value}}\n`;
    success(
      cli,
      ['start', 'feature', task],
      `Run: RUN-ID\nStep: loop\n\nTask: ${task}\nValue: -\nEmpty: [-]\n${extra('-')}\n${exit}`,
    );
    const output = `Run: RUN-ID\nStep: loop\n\nTask: ${task}\nValue: ${value}\nEmpty: []\n${extra(value)}\n${exit}`;
    success(cli, ['next', cli.id, '--value', value, '--empty='], output);
    current(cli, output);
    expect(runView(readRun(cli)).outcomes.loop).toEqual({ value, empty: '' });
    expect(readRun(cli).task).toBe(task);
    expect(readRun(cli).events[1]).toMatchObject({ outcome: { value, empty: '' } });
  });

  it('keeps placeholder-like enum values literal in the exit template and inserted outcome', () => {
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
    const exit = 'stepan next RUN-ID --verdict <{{task}}|done>\n';
    success(
      cli,
      ['start', 'feature', 'TASK-5'],
      `Run: RUN-ID\nStep: choose\n\nTask TASK-5; last -.\n\n${exit}`,
    );
    const output = `Run: RUN-ID\nStep: choose\n\nTask TASK-5; last {{task}}.\n\n${exit}`;
    success(cli, ['next', cli.id, '--verdict', '{{task}}'], output);
    current(cli, output);
    expect(readFileSync(join(cli.cwd, '.stepan/flows/feature/choose.md'), 'utf8')).toBe(
      instruction,
    );
  });
});
