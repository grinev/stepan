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
  'Plan {{task}}.\n\nstepan next plan --plan "<text>" [--note "<text>"] [--reason <small|large>]\n';
const REVIEW =
  'Review {{steps.plan.outcome.plan}}.\n\nstepan next review --verdict <pass|fail|hold> [--findings "<text>"]\n';
const FINISH = 'Finish.\n\nstepan next finish\n';

function fixture(layout: 'installed' | 'sources' = 'installed', flow = FLOW): CliSandbox {
  const cli = createCli(layout);
  const directory = join(cli.cwd, 'flows/feature');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'flow.yaml'), flow);
  writeFileSync(join(directory, 'plan.md'), 'Plan {{task}}.\n');
  writeFileSync(join(directory, 'review.md'), 'Review {{steps.plan.outcome.plan}}.\n');
  writeFileSync(join(directory, 'finish.md'), 'Finish.');
  const result = runCli(['start', 'feature', 'STP-4: задача'], cli);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  return cli;
}

function readRun(cli: CliSandbox): RunState {
  return JSON.parse(readFileSync(cli.runPath, 'utf8')) as RunState;
}

function success(cli: CliSandbox, args: string[], stdout: string): void {
  const result = runCli(args, cli);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(stdout);
  expect(result.stderr).toBe('');
  expect(readdirSync(dirname(cli.runPath))).toEqual(['run.json']);
}

function refusal(cli: CliSandbox, args: string[], code: number, message: string): void {
  const before = readFileSync(cli.runPath, 'utf8');
  const result = runCli(args, cli);
  expect(result.code).toBe(code);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain('\n    at ');
  expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
  expect(existsSync(join(dirname(cli.runPath), 'start.lock'))).toBe(false);
}

describe('stepan next', () => {
  it.each(['installed', 'sources'] as const)(
    'walks a full loop and finishes in the isolated %s layout',
    (layout) => {
      const cli = fixture(layout);
      const snapshot = readRun(cli).flow;
      success(cli, ['current'], PLAN);
      success(
        cli,
        ['next', 'plan', '--plan', 'первый план', '--note', 'remove', '--reason', 'small'],
        REVIEW,
      );
      expect(readRun(cli)).toMatchObject({
        step: 'review',
        finished: false,
        outcomes: { plan: { plan: 'первый план', note: 'remove', reason: 'small' } },
      });
      success(cli, ['current'], REVIEW);
      success(cli, ['next', 'review', '--verdict', 'fail', '--findings', 'revise'], PLAN);
      success(cli, ['next', 'plan', '--plan=новый план'], REVIEW);
      expect(readRun(cli).outcomes).toEqual({
        plan: { plan: 'новый план' },
        review: { verdict: 'fail', findings: 'revise' },
      });
      success(cli, ['next', 'review', '--verdict=pass'], FINISH);
      expect(readRun(cli)).toMatchObject({ step: 'finish', finished: false });
      success(cli, ['current'], FINISH);
      success(cli, ['next', 'finish'], 'Run is finished.\n');
      const finished = readRun(cli);
      expect(finished).toEqual({
        version: 1,
        task: 'STP-4: задача',
        step: 'finish',
        finished: true,
        flow: snapshot,
        outcomes: { plan: { plan: 'новый план' }, review: { verdict: 'pass' }, finish: {} },
      });
      success(cli, ['current'], 'Run is finished.\n');
      refusal(cli, ['next', 'finish'], 1, 'Run is finished.');
      refusal(cli, ['next', 'finish', '--unknown'], 1, 'Run is finished.');

      const other =
        layout === 'sources' ? join(cli.cwd, '.stepan') : join(cli.packageRoot, '.dev-data');
      expect(existsSync(other)).toBe(false);
      for (const path of ['.stepan', '.config', 'AppData', '.local'])
        expect(existsSync(join(cli.sandbox, path))).toBe(false);
    },
  );

  it.each([
    { args: ['other', '--unknown'], code: 1, message: "current: 'plan'" },
    { args: ['plan'], code: 1, message: 'plan: required' },
    { args: ['plan', '--plan='], code: 1, message: 'plan: required' },
    {
      args: ['plan', '--plan', 'value', '--reason', 'other'],
      code: 1,
      message: 'reason: invalid enum',
    },
    { args: ['plan', '--plan', 'value', '--unknown', 'x'], code: 2, message: 'unknown' },
    { args: ['plan', '--plan=value', '--plan', 'again'], code: 2, message: 'Repeated option' },
    { args: ['plan', '--plan'], code: 2, message: 'argument' },
    { args: ['plan', '--plan', 'value', 'extra'], code: 2, message: 'argument' },
    { args: ['plan', '-p', 'value'], code: 2, message: 'option' },
    { args: ['plan', '--help'], code: 2, message: 'option' },
  ])('refuses invalid step or outcome without changing the run (%#)', ({ args, code, message }) => {
    const cli = fixture();
    refusal(cli, ['next', ...args], code, message);
    expect(readRun(cli).outcomes).toEqual({});
    success(cli, ['current'], PLAN);
  });

  it.each([
    { args: [], message: 'verdict: required' },
    { args: ['--verdict='], message: 'verdict: required' },
    { args: ['--verdict', 'other'], message: 'verdict: invalid enum' },
    { args: ['--verdict', 'hold'], message: 'no matching transition' },
  ])('refuses a missing or invalid enum or unmatched transition (%#)', ({ args, message }) => {
    const cli = fixture();
    success(cli, ['next', 'plan', '--plan', 'value'], REVIEW);
    refusal(cli, ['next', 'review', ...args], 1, message);
    expect(readRun(cli).outcomes).toEqual({ plan: { plan: 'value' } });
    success(cli, ['current'], REVIEW);
  });

  it('uses the original schema, transitions and instructions after editing and removing flow files', () => {
    const cli = fixture();
    const directory = join(cli.cwd, 'flows/feature');
    writeFileSync(
      join(directory, 'flow.yaml'),
      FLOW.replaceAll('plan', 'changed').replace('to: review', 'to: finish'),
    );
    writeFileSync(join(directory, 'review.md'), 'Changed instruction.');
    success(cli, ['next', 'plan', '--plan', 'saved schema'], REVIEW);
    rmSync(join(cli.cwd, 'flows'), { recursive: true });
    success(cli, ['next', 'review', '--verdict=fail'], PLAN);
    success(cli, ['current'], PLAN);
  });

  it('tries a conditional before the default and accepts a missing optional field', () => {
    const flow = `start: plan
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
`;
    const cli = fixture('installed', flow);
    success(
      cli,
      ['next', 'plan', '--note='],
      'Plan {{task}}.\n\nstepan next plan [--note "<text>"]\n',
    );
    expect(readRun(cli).outcomes.plan).toEqual({ note: '' });
    success(cli, ['next', 'plan'], FINISH);
    expect(readRun(cli).outcomes.plan).toEqual({});
  });

  it('requires the final outcome before marking the run finished', () => {
    const cli = fixture(
      'installed',
      `start: finish
steps:
  finish:
    instruction: finish.md
    outcome:
      summary: {type: string, required: true}
`,
    );
    refusal(cli, ['next', 'finish'], 1, 'summary: required');
    expect(readRun(cli).finished).toBe(false);
    success(cli, ['next', 'finish', '--summary', 'Done.'], 'Run is finished.\n');
    expect(readRun(cli).outcomes.finish).toEqual({ summary: 'Done.' });
  });

  it('accepts help, h, version and prototype names as outcome fields and preserves exact strings', () => {
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
    refusal(cli, ['next', 'plan', '-x', 'value'], 2, 'flag');
    refusal(cli, ['next', 'plan', '--help'], 2, 'argument');
    success(
      cli,
      [
        'next',
        'plan',
        '--help',
        '  ',
        '--h=',
        '--version=0',
        '--constructor=-text',
        '--toString',
        'текст с пробелами',
      ],
      'Run is finished.\n',
    );
    expect(readRun(cli).outcomes.plan).toEqual({
      help: '  ',
      h: '',
      version: '0',
      constructor: '-text',
      toString: 'текст с пробелами',
    });
  });

  it.each(['--help', '-h'])('prints standalone %s without accessing state', (flag) => {
    const cli = createCli();
    const help = runCli(['next', flag], cli);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('Usage: stepan next');
    expect(existsSync(dirname(cli.runPath))).toBe(false);
    mkdirSync(dirname(cli.runPath));
    writeFileSync(cli.runPath, '{broken');
    expect(runCli(['next', flag], cli).stdout).toBe(help.stdout);
    expect(readFileSync(cli.runPath, 'utf8')).toBe('{broken');
  });

  it.each([[], [''], ['--verdict', 'pass'], ['--help', 'extra'], ['-h', '--help']])(
    'rejects malformed command arguments without creating state (%#)',
    (...args) => {
      const cli = createCli();
      const result = runCli(['next', ...args], cli);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Usage: stepan next');
      expect(existsSync(dirname(cli.runPath))).toBe(false);
    },
  );

  it.each(['installed', 'sources'] as const)(
    'reports a missing run without creating the %s state directory',
    (layout) => {
      const cli = createCli(layout);
      const result = runCli(['next', 'plan', '--plan', 'value'], cli);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('No run found');
      expect(existsSync(dirname(cli.runPath))).toBe(false);
    },
  );

  it.each(['{invalid', '{"version":99}', '{"version":1,"finished":true}'])(
    'preserves unreadable or unknown-version state (%#)',
    (text) => {
      const cli = createCli();
      mkdirSync(dirname(cli.runPath));
      writeFileSync(cli.runPath, text);
      refusal(cli, ['next', 'plan', '--plan', 'value'], 1, 'run.json');
    },
  );

  it('does not replace an unreadable run path', () => {
    const cli = createCli();
    mkdirSync(cli.runPath, { recursive: true });
    const result = runCli(['next', 'plan'], cli);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Cannot read run');
    expect(readdirSync(cli.runPath)).toEqual([]);
    expect(readdirSync(dirname(cli.runPath))).toEqual(['run.json']);
  });

  it('refuses a busy shared lock without changing the run or the lock', () => {
    const cli = fixture();
    const before = readFileSync(cli.runPath, 'utf8');
    const lock = join(dirname(cli.runPath), 'start.lock');
    writeFileSync(lock, 'busy');
    const result = runCli(['next', 'plan', '--plan', 'value'], cli);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Another command');
    expect(result.stderr).toContain(lock);
    expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
    expect(readFileSync(lock, 'utf8')).toBe('busy');
  });

  it('lists next in general help', () => {
    const result = runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('next <step>');
  });
});
