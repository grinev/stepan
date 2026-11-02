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
      verdict: {type: enum, values: [pass, fail], required: true}
      reason: {type: enum, values: [small, large]}
    transitions:
      - to: finish
  finish:
    instruction: finish.md
`;
const STEP_OUTPUT =
  'Plan STP-3: задача.\n\nstepan next plan --plan "<text>" [--note "<text>"] --verdict <pass|fail> [--reason <small|large>]\n';

function fixture(layout: 'installed' | 'sources' = 'installed'): CliSandbox {
  const cli = createCli(layout);
  const directory = join(cli.cwd, 'flows/feature');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'flow.yaml'), FLOW);
  writeFileSync(join(directory, 'plan.md'), 'Plan {{task}}.\n');
  writeFileSync(join(directory, 'finish.md'), 'Finish {{steps.plan.outcome.plan}}.');
  return cli;
}

function start(cli: CliSandbox): void {
  const result = runCli(['start', 'feature', 'STP-3: задача'], cli);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(`plan -> finish\nfinish (final)\n\n${STEP_OUTPUT}`);
}

function readRun(cli: CliSandbox): RunState {
  return JSON.parse(readFileSync(cli.runPath, 'utf8')) as RunState;
}

function writeRun(cli: CliSandbox, text: string): void {
  mkdirSync(dirname(cli.runPath), { recursive: true });
  writeFileSync(cli.runPath, text);
}

function expectStep(cli: CliSandbox, stdout = STEP_OUTPUT): void {
  const before = readFileSync(cli.runPath, 'utf8');
  const result = runCli(['current'], cli);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(stdout);
  expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
  expect(readdirSync(dirname(cli.runPath))).toEqual(['run.json']);
}

describe('stepan current', () => {
  it.each(['installed', 'sources'] as const)(
    'resumes from the isolated %s snapshot even after changing or removing flow files',
    (layout) => {
      const cli = fixture(layout);
      start(cli);
      expectStep(cli);

      const directory = join(cli.cwd, 'flows/feature');
      writeFileSync(join(directory, 'flow.yaml'), FLOW.replaceAll('plan', 'different'));
      writeFileSync(join(directory, 'plan.md'), 'Changed instruction.');
      expectStep(cli);

      rmSync(join(cli.cwd, 'flows'), { recursive: true });
      expectStep(cli);

      const other =
        layout === 'sources' ? join(cli.cwd, '.stepan') : join(cli.packageRoot, '.dev-data');
      expect(existsSync(other)).toBe(false);
      for (const path of ['.stepan', '.config', 'AppData', '.local']) {
        expect(existsSync(join(cli.sandbox, path))).toBe(false);
      }
    },
  );

  it('prints run.step rather than flow.start, including a final step without outcomes', () => {
    const cli = fixture();
    start(cli);
    writeRun(cli, JSON.stringify({ ...readRun(cli), step: 'finish' }));
    expectStep(cli, 'Finish {{steps.plan.outcome.plan}}.\n\nstepan next finish\n');
  });

  it('reports a finished run with exit code 0 without printing a step', () => {
    const cli = fixture();
    start(cli);
    writeRun(cli, JSON.stringify({ ...readRun(cli), step: 'finish', finished: true }));
    expectStep(cli, 'Run is finished.\n');
  });

  it.each(['installed', 'sources'] as const)(
    'refuses a missing run in the %s root without creating state',
    (layout) => {
      const cli = createCli(layout);
      const result = runCli(['current'], cli);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('No run found');
      expect(result.stderr).toContain(cli.runPath);
      expect(existsSync(dirname(cli.runPath))).toBe(false);
      expect(existsSync(join(cli.cwd, '.stepan'))).toBe(false);
    },
  );

  it.each([
    { label: 'broken JSON', change: () => '{invalid', message: 'JSON' },
    {
      label: 'unknown version',
      change: (state: RunState) => JSON.stringify({ ...state, version: 99 }),
      message: 'Unsupported run version',
    },
    {
      label: 'missing current step',
      change: (state: RunState) => JSON.stringify({ ...state, step: 'missing' }),
      message: 'run.step',
    },
    {
      label: 'invalid finished snapshot',
      change: (state: RunState) => JSON.stringify({ ...state, finished: true, flow: null }),
      message: 'flow',
    },
  ])('refuses $label without changing state', ({ change, message }) => {
    const cli = fixture();
    start(cli);
    const text = change(readRun(cli));
    writeRun(cli, text);
    const result = runCli(['current'], cli);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain(cli.runPath);
    expect(result.stderr).not.toContain('\n    at ');
    expect(readFileSync(cli.runPath, 'utf8')).toBe(text);
    expect(readdirSync(dirname(cli.runPath))).toEqual(['run.json']);
  });

  it('refuses an unreadable run path without changing it', () => {
    const cli = createCli();
    mkdirSync(cli.runPath, { recursive: true });
    const result = runCli(['current'], cli);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Cannot read run');
    expect(result.stderr).toContain(cli.runPath);
    expect(result.stderr).not.toContain('\n    at ');
    expect(readdirSync(cli.runPath)).toEqual([]);
    expect(readdirSync(dirname(cli.runPath))).toEqual(['run.json']);
  });

  it.each(['--help', '-h'])('prints %s without reading or creating state', (flag) => {
    const cli = createCli();
    const result = runCli(['current', flag], cli);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Usage: stepan current\n');
    expect(result.stderr).toBe('');
    expect(existsSync(dirname(cli.runPath))).toBe(false);

    writeRun(cli, '{invalid');
    expect(runCli(['current', flag], cli).code).toBe(0);
    expect(readFileSync(cli.runPath, 'utf8')).toBe('{invalid');
  });

  it.each([
    ['extra'],
    ['--', 'extra'],
    ['--unknown'],
    ['--help=true'],
    ['--help', '-h'],
    ['-hh'],
    ['--help', 'extra'],
  ])('rejects malformed arguments without reading or creating state (%#)', (...args) => {
    const cli = createCli();
    const result = runCli(['current', ...args], cli);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: stepan current');
    expect(existsSync(dirname(cli.runPath))).toBe(false);

    writeRun(cli, '{invalid');
    expect(runCli(['current', ...args], cli).code).toBe(2);
    expect(readFileSync(cli.runPath, 'utf8')).toBe('{invalid');
  });

  it('lists current in general help', () => {
    const result = runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('current');
    expect(result.stderr).toBe('');
  });
});
