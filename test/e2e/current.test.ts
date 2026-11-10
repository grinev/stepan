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
      verdict: {type: enum, values: [pass, fail], required: true}
      reason: {type: enum, values: [small, large]}
    transitions:
      - to: finish
  finish:
    instruction: finish.md
`;
function fixture(layout: 'installed' | 'sources' = 'installed'): RunningCli {
  const cli = createCli(layout);
  const directory = join(cli.cwd, '.stepan/flows/feature');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'flow.yaml'), FLOW);
  writeFileSync(join(directory, 'plan.md'), 'Plan {{task}}.\n');
  writeFileSync(join(directory, 'finish.md'), 'Finish {{steps.plan.outcome.plan}}.');
  return startCli(cli, 'STP-8: задача');
}
function readRun(cli: RunningCli): RunState {
  return JSON.parse(readFileSync(cli.runPath, 'utf8')) as RunState;
}
function expectStep(cli: RunningCli, stdout?: string): void {
  const before = readFileSync(cli.runPath, 'utf8');
  const result = runCli(['current', cli.id], cli);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  expect(result.stdout).toBe(
    stdout ??
      `Run: ${cli.id}\nStep: plan\n\nInstructions:\nPlan STP-8: задача.\n\nAfter completing this step, run:\nstepan next ${cli.id} --plan "<text>" [--note "<text>"] --verdict <pass|fail> [--reason <small|large>]\n`,
  );
  expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
  expect(readdirSync(cli.runsDirectory)).toEqual([`${cli.id}.json`]);
}

describe('stepan current', () => {
  it.each(['installed', 'sources'] as const)(
    'reads current instructions and refuses missing %s flow files',
    (layout) => {
      const cli = fixture(layout);
      expectStep(cli);
      const directory = join(cli.cwd, '.stepan/flows/feature');
      writeFileSync(join(directory, 'plan.md'), 'Changed instruction.');
      expectStep(
        cli,
        `Run: ${cli.id}\nStep: plan\n\nInstructions:\nChanged instruction.\n\nAfter completing this step, run:\nstepan next ${cli.id} --plan "<text>" [--note "<text>"] --verdict <pass|fail> [--reason <small|large>]\n`,
      );
      rmSync(join(cli.cwd, '.stepan/flows'), { recursive: true });
      const before = readFileSync(cli.runPath, 'utf8');
      expect(runCli(['current', cli.id], cli)).toMatchObject({ code: 1, stdout: '' });
      expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
      expect(readdirSync(cli.runsDirectory)).toEqual([`${cli.id}.json`]);
      const other =
        layout === 'sources' ? join(cli.cwd, '.stepan/runs') : join(cli.packageRoot, '.dev-data');
      expect(existsSync(other)).toBe(false);
    },
  );

  it('prints the actual current step, including a final step without outcomes', () => {
    const cli = fixture();
    expect(runCli(['next', cli.id, '--plan=plan.md', '--verdict=pass'], cli).code).toBe(0);
    expectStep(
      cli,
      `Run: ${cli.id}\nStep: finish\n\nInstructions:\nFinish plan.md.\n\nAfter completing this step, run:\nstepan next ${cli.id}\n`,
    );
  });

  it('reports completion with the run ID and exit code 0', () => {
    const cli = fixture();
    expect(runCli(['next', cli.id, '--plan=plan.md', '--verdict=pass'], cli).code).toBe(0);
    expect(runCli(['next', cli.id], cli).code).toBe(0);
    rmSync(join(cli.cwd, '.stepan/flows'), { recursive: true });
    expectStep(cli, `Run ${cli.id} is finished.\n`);
  });

  it.each(['installed', 'sources'] as const)(
    'refuses missing %s state without creating it',
    (layout) => {
      const cli = createCli(layout);
      const result = runCli(['current', ID], cli);
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain('No run found');
      expect(result.stderr).toContain(runPath(cli, ID));
      expect(existsSync(cli.runsDirectory)).toBe(false);
    },
  );

  it.each([
    { change: () => '{invalid', message: 'JSON' },
    {
      change: (state: RunState) => JSON.stringify({ ...state, version: 99 }),
      message: 'Unsupported run version',
    },
    {
      change: (state: RunState) => JSON.stringify({ ...state, events: [] }),
      message: 'run.events',
    },
    {
      change: (state: RunState) =>
        JSON.stringify({
          ...state,
          events: [
            ...state.events,
            {
              type: 'transitioned',
              at: '2026-11-05T10:00:00.000Z',
              from: 'other',
              to: 'finish',
              outcome: {},
            },
          ],
        }),
      message: 'run.events[1]: expected current step',
    },
    {
      change: (state: RunState) =>
        JSON.stringify({
          ...state,
          events: [
            ...state.events,
            { type: 'finished', at: 'not a timestamp', step: 'plan', outcome: {} },
          ],
        }),
      message: 'run.events[1].at',
    },
    {
      change: (state: RunState) => JSON.stringify({ ...state, flow: null }),
      message: 'flow',
    },
    {
      change: (state: RunState) => JSON.stringify({ ...state, version: 1 }),
      message: 'Unsupported run version: 1',
    },
    { change: (state: RunState) => JSON.stringify({ ...state, id: ID }), message: 'filename' },
  ])('refuses invalid state without changing it (%#)', ({ change, message }) => {
    const cli = fixture();
    const text = change(readRun(cli));
    writeFileSync(cli.runPath, text);
    const result = runCli(['current', cli.id], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain(cli.runPath);
    expect(result.stderr).not.toContain('\n    at ');
    expect(readFileSync(cli.runPath, 'utf8')).toBe(text);
    expect(readdirSync(cli.runsDirectory)).toEqual([`${cli.id}.json`]);
  });

  it('preserves an unreadable run path', () => {
    const cli = createCli();
    const path = runPath(cli, ID);
    mkdirSync(path, { recursive: true });
    const result = runCli(['current', ID], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain(path);
    expect(readdirSync(path)).toEqual([]);
  });

  it.each(['--help', '-h'])('prints standalone %s without state', (flag) => {
    const cli = createCli();
    const result = runCli(['current', flag], cli);
    expect(result).toMatchObject({
      code: 0,
      stdout: 'Usage: stepan current <run-id>\n',
      stderr: '',
    });
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });

  it.each([
    [],
    ['extra'],
    ['../outside'],
    ['--unknown'],
    ['--help=true'],
    ['--help', '-h'],
    ['-hh'],
    ['--help', ID],
    [ID, 'extra'],
  ])('rejects malformed arguments without state (%#)', (...args) => {
    const cli = createCli();
    const result = runCli(['current', ...args], cli);
    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toContain('Usage: stepan current');
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });
});
