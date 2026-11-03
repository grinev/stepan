import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunState } from '../../src/run.js';
import { createCli, runCli, runPath, startCli, type RunningCli } from './run-cli.js';

const ID = 'a7c93f2b';
const FLOW = `start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      plan: {type: string, required: true}
      note: {type: string}
      reason: {type: enum, values: [small, large]}
    transitions:
      - to: review
  review:
    instruction: review.md
    outcome:
      verdict: {type: enum, values: [pass, fail, hold], required: true}
      findings: {type: string}
    transitions:
      - when: {verdict: fail}
        to: plan
      - when: {verdict: pass}
        to: finish
  finish:
    instruction: finish.md
`;
const PLAN =
  'Run: RUN-ID\nStep: plan\n\nPlan STP-8: задача.\n\nstepan next RUN-ID --plan "<text>" [--note "<text>"] [--reason <small|large>]\n';
function reviewOutput(plan: string): string {
  return `Run: RUN-ID\nStep: review\n\nReview ${plan}.\n\nstepan next RUN-ID --verdict <pass|fail|hold> [--findings "<text>"]\n`;
}
const FINISH = 'Run: RUN-ID\nStep: finish\n\nFinish.\n\nstepan next RUN-ID\n';
const FINISHED = 'Run RUN-ID is finished.\n';

function fixture(layout: 'installed' | 'sources' = 'installed', flow = FLOW): RunningCli {
  const cli = createCli(layout);
  const directory = join(cli.cwd, '.stepan/flows/feature');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'flow.yaml'), flow);
  writeFileSync(join(directory, 'plan.md'), 'Plan {{task}}.\n');
  writeFileSync(join(directory, 'review.md'), 'Review {{steps.plan.outcome.plan}}.\n');
  writeFileSync(join(directory, 'finish.md'), 'Finish.');
  return startCli(cli, 'STP-8: задача');
}
function readRun(cli: RunningCli): RunState {
  return JSON.parse(readFileSync(cli.runPath, 'utf8')) as RunState;
}
function success(cli: RunningCli, args: string[], stdout: string): void {
  const result = runCli(args, cli);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  expect(result.stdout.replaceAll(cli.id, 'RUN-ID')).toBe(stdout);
  expect(readdirSync(cli.runsDirectory)).toEqual([`${cli.id}.json`]);
}
function refusal(cli: RunningCli, args: string[], code: number, message: string): void {
  const before = readFileSync(cli.runPath, 'utf8');
  const result = runCli(args, cli);
  expect(result).toMatchObject({ code, stdout: '' });
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain('\n    at ');
  expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
  expect(existsSync(join(cli.runsDirectory, `${cli.id}.lock`))).toBe(false);
}

describe('stepan next', () => {
  it.each(['installed', 'sources'] as const)(
    'walks a full loop and finishes in the isolated %s layout',
    (layout) => {
      const cli = fixture(layout);
      const snapshot = readRun(cli).flow;
      success(cli, ['current', cli.id], PLAN);
      success(
        cli,
        ['next', cli.id, '--plan', 'первый план', '--note', 'remove', '--reason', 'small'],
        reviewOutput('первый план'),
      );
      expect(readRun(cli)).toMatchObject({
        step: 'review',
        finished: false,
        outcomes: { plan: { plan: 'первый план', note: 'remove', reason: 'small' } },
      });
      success(cli, ['current', cli.id], reviewOutput('первый план'));
      success(cli, ['next', cli.id, '--verdict=fail', '--findings=revise'], PLAN);
      success(cli, ['next', cli.id, '--plan=новый план'], reviewOutput('новый план'));
      expect(readRun(cli).outcomes).toEqual({
        plan: { plan: 'новый план' },
        review: { verdict: 'fail', findings: 'revise' },
      });
      success(cli, ['next', cli.id, '--verdict=pass'], FINISH);
      expect(readRun(cli)).toMatchObject({ step: 'finish', finished: false });
      success(cli, ['current', cli.id], FINISH);
      success(cli, ['next', cli.id], FINISHED);
      expect(readRun(cli)).toEqual({
        version: 1,
        id: cli.id,
        flowName: 'feature',
        task: 'STP-8: задача',
        step: 'finish',
        finished: true,
        flow: snapshot,
        outcomes: { plan: { plan: 'новый план' }, review: { verdict: 'pass' }, finish: {} },
      });
      success(cli, ['current', cli.id], FINISHED);
      refusal(cli, ['next', cli.id], 1, 'is finished.');
      refusal(cli, ['next', cli.id, '--unknown'], 1, 'is finished.');
      const other =
        layout === 'sources' ? join(cli.cwd, '.stepan/runs') : join(cli.packageRoot, '.dev-data');
      expect(existsSync(other)).toBe(false);
      for (const path of ['.stepan', '.config', 'AppData', '.local'])
        expect(existsSync(join(cli.sandbox, path))).toBe(false);
    },
  );

  it.each([
    { args: ['plan', '--plan=value'], code: 2, message: 'argument' },
    { args: [], code: 1, message: 'plan: required' },
    { args: ['--plan='], code: 1, message: 'plan: required' },
    { args: ['--plan=value', '--reason=other'], code: 1, message: 'reason: invalid enum' },
    { args: ['--plan=value', '--unknown=x'], code: 2, message: 'unknown' },
    { args: ['--plan=value', '--plan=again'], code: 2, message: 'Repeated option' },
    { args: ['--plan'], code: 2, message: 'argument' },
    { args: ['--plan=value', 'extra'], code: 2, message: 'argument' },
    { args: ['-p', 'value'], code: 2, message: 'option' },
    { args: ['--help'], code: 2, message: 'option' },
  ])(
    'refuses invalid outcome or an extra step without changing state (%#)',
    ({ args, code, message }) => {
      const cli = fixture();
      refusal(cli, ['next', cli.id, ...args], code, message);
      expect(readRun(cli).outcomes).toEqual({});
      success(cli, ['current', cli.id], PLAN);
    },
  );

  it.each([
    { args: [], message: 'verdict: required' },
    { args: ['--verdict='], message: 'verdict: required' },
    { args: ['--verdict=other'], message: 'verdict: invalid enum' },
    { args: ['--verdict=hold'], message: 'no matching transition' },
  ])('refuses invalid enum or unmatched transition (%#)', ({ args, message }) => {
    const cli = fixture();
    success(cli, ['next', cli.id, '--plan=value'], reviewOutput('value'));
    refusal(cli, ['next', cli.id, ...args], 1, message);
    expect(readRun(cli).outcomes).toEqual({ plan: { plan: 'value' } });
    success(cli, ['current', cli.id], reviewOutput('value'));
  });

  it('uses the snapshot after editing and removing flow files', () => {
    const cli = fixture();
    const directory = join(cli.cwd, '.stepan/flows/feature');
    writeFileSync(
      join(directory, 'flow.yaml'),
      FLOW.replaceAll('plan', 'changed').replace('to: review', 'to: finish'),
    );
    writeFileSync(join(directory, 'review.md'), 'Changed instruction.');
    success(cli, ['next', cli.id, '--plan=saved schema'], reviewOutput('saved schema'));
    rmSync(join(cli.cwd, '.stepan/flows'), { recursive: true });
    success(cli, ['next', cli.id, '--verdict=fail'], PLAN);
    success(cli, ['current', cli.id], PLAN);
  });

  it('tries a conditional before the default and replaces optional fields', () => {
    const cli = fixture(
      'installed',
      `start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      note: {type: string}
    transitions:
      - when: {note: ''}
        to: plan
      - to: finish
  finish:
    instruction: finish.md
`,
    );
    success(
      cli,
      ['next', cli.id, '--note='],
      'Run: RUN-ID\nStep: plan\n\nPlan STP-8: задача.\n\nstepan next RUN-ID [--note "<text>"]\n',
    );
    expect(readRun(cli).outcomes.plan).toEqual({ note: '' });
    success(cli, ['next', cli.id], FINISH);
    expect(readRun(cli).outcomes.plan).toEqual({});
  });

  it('requires the final outcome before marking the run finished', () => {
    const cli = fixture(
      'installed',
      'start: finish\nsteps:\n  finish:\n    instruction: finish.md\n    outcome:\n      summary: {type: string, required: true}\n',
    );
    refusal(cli, ['next', cli.id], 1, 'summary: required');
    expect(readRun(cli).finished).toBe(false);
    success(cli, ['next', cli.id, '--summary=Done.'], FINISHED);
    expect(readRun(cli).outcomes.finish).toEqual({ summary: 'Done.' });
  });

  it('accepts help, h, version and prototype names and preserves exact strings', () => {
    const cli = fixture(
      'installed',
      `start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      help: {type: string, required: true}
      h: {type: string}
      version: {type: string}
      constructor: {type: string}
      toString: {type: string}
      x: {type: string}
`,
    );
    refusal(cli, ['next', cli.id, '-x', 'value'], 2, 'flag');
    refusal(cli, ['next', cli.id, '--help'], 2, 'argument');
    success(
      cli,
      [
        'next',
        cli.id,
        '--help',
        '  ',
        '--h=',
        '--version=0',
        '--constructor=-text',
        '--toString',
        'текст с пробелами',
      ],
      FINISHED,
    );
    expect(readRun(cli).outcomes.plan).toEqual({
      help: '  ',
      h: '',
      version: '0',
      constructor: '-text',
      toString: 'текст с пробелами',
    });
  });

  it.each(['--help', '-h'])('prints standalone %s without state', (flag) => {
    const cli = createCli();
    const result = runCli(['next', flag], cli);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('Usage: stepan next <run-id>');
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });

  it.each([
    [],
    [''],
    ['plan'],
    ['../outside'],
    ['A7C93F2B'],
    ['--verdict', 'pass'],
    ['--help', 'extra'],
    ['-h', '--help'],
  ])('rejects missing or invalid IDs without creating state (%#)', (...args) => {
    const cli = createCli();
    const result = runCli(['next', ...args], cli);
    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toContain('Usage: stepan next');
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });

  it.each(['installed', 'sources'] as const)(
    'reports missing state without creating the %s directory',
    (layout) => {
      const cli = createCli(layout);
      const result = runCli(['next', ID, '--plan=value'], cli);
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain('No run found');
      expect(existsSync(cli.runsDirectory)).toBe(false);
    },
  );

  it.each(['{invalid', '{"version":99}', '{"version":1,"finished":true}'])(
    'preserves unreadable or unknown-version state (%#)',
    (text) => {
      const cli = fixture();
      writeFileSync(cli.runPath, text);
      refusal(cli, ['next', cli.id, '--plan=value'], 1, cli.runPath);
    },
  );

  it('preserves an unreadable run path', () => {
    const cli = createCli();
    const path = runPath(cli, ID);
    mkdirSync(path, { recursive: true });
    const result = runCli(['next', ID], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain(path);
    expect(readdirSync(path)).toEqual([]);
    expect(readdirSync(cli.runsDirectory)).toEqual([`${ID}.json`]);
  });

  it('refuses a busy per-run lock without modifying it', () => {
    const cli = fixture();
    const before = readFileSync(cli.runPath, 'utf8');
    const lock = join(cli.runsDirectory, `${cli.id}.lock`);
    writeFileSync(lock, 'busy');
    const result = runCli(['next', cli.id, '--plan=value'], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain('Another command');
    expect(result.stderr).toContain(lock);
    expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
    expect(readFileSync(lock, 'utf8')).toBe('busy');
  });
});
