import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './main.js';
import * as store from './run-store.js';
import { advanceRun, type RunState } from './run.js';
import * as flows from './flow.js';
import * as roots from './write-root.js';

const ID = 'a7c93f2b';
function capture(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

const state: RunState = {
  version: 2,
  id: ID,
  flowName: 'feature',
  task: 'TASK-1',
  events: [{ type: 'started', step: 'review', at: '2026-11-05T10:00:00.000Z' }],
};
const flow: flows.Flow = {
  start: 'review',
  steps: {
    review: {
      instruction: 'Review {{task}}.',
      outcome: {
        verdict: { type: 'enum', values: ['pass', 'fail'], required: true },
        note: { type: 'string' },
        help: { type: 'string' },
        h: { type: 'string' },
        version: { type: 'string' },
        constructor: { type: 'string' as const },
        x: { type: 'string' },
      },
      transitions: [{ to: 'finish' }],
    },
    finish: {
      instruction: 'Finish {{steps.review.outcome.note}}.',
      outcome: { summary: { type: 'string', required: true } },
      transitions: [],
    },
  },
};
const moved = (): RunState => advanceRun(state, flow, { verdict: 'pass' });
const finished = (): RunState => advanceRun(moved(), flow, { summary: 'Done.' });

beforeEach(() => {
  vi.spyOn(roots, 'writeRoot').mockReturnValue('isolated-root');
  vi.spyOn(store, 'loadRun').mockReturnValue(state);
  vi.spyOn(store, 'updateRun').mockImplementation((_root, _id, update) => update(state));
  vi.spyOn(store, 'removeRun').mockImplementation(() => undefined);
  vi.spyOn(store, 'listRuns').mockReturnValue([]);
  vi.spyOn(flows, 'loadFlow').mockReturnValue(flow);
});
afterEach(() => vi.restoreAllMocks());

describe('run', () => {
  it('prints usage, version and unknown-command errors', () => {
    expect(capture([])).toMatchObject({ code: 0, stderr: '' });
    expect(capture([]).stdout).toContain('next <run-id>');
    expect(capture([]).stdout).toContain('rm <run-id>');
    expect(capture([]).stdout).not.toContain('abort');
    expect(capture(['--version']).stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect(capture(['unknown'])).toMatchObject({ code: 2, stdout: '' });
    expect(capture(['abort', ID])).toMatchObject({ code: 2, stdout: '' });
  });

  it.each(['start', 'current', 'next', 'rm', 'runs'])(
    'prints standalone help for %s without I/O',
    (command) => {
      for (const flag of ['-h', '--help']) {
        const result = capture([command, flag]);
        expect(result).toMatchObject({ code: 0, stderr: '' });
        expect(result.stdout).toContain(`Usage: stepan ${command}`);
      }
      expect(roots.writeRoot).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['start'],
    ['start', 'feature', ''],
    ['start', 'feature', 'task', 'extra'],
    ['start', '--help', '-h'],
    ['start', '--unknown'],
    ['current'],
    ['current', ID, 'extra'],
    ['current', '--help', ID],
    ['current', '-hh'],
    ['rm'],
    ['rm', ID, '--unknown'],
    ['rm', '--help', '-h'],
    ['next'],
    ['next', 'review'],
    ['next', '../outside'],
    ['next', '--verdict', 'pass'],
    ['runs', '--all', '--all'],
    ['runs', 'extra'],
    ['runs', '--help', '--all'],
    ['runs', '--unknown'],
  ])('rejects bad command arguments before accessing state (%#)', (...args) => {
    expect(capture(args)).toMatchObject({ code: 2, stdout: '' });
    expect(roots.writeRoot).not.toHaveBeenCalled();
  });
});

describe('next', () => {
  it('parses long values using locked state and prints the saved next step', () => {
    expect(capture(['next', ID, '--verdict=pass', '--note', 'текст с пробелами'])).toEqual({
      code: 0,
      stderr: '',
      stdout: `Run: ${ID}\nStep: finish\n\nFinish текст с пробелами.\n\nstepan next ${ID} --summary "<text>"\n`,
    });
    expect(store.loadRun).not.toHaveBeenCalled();
    expect(store.updateRun).toHaveBeenCalledWith('isolated-root', ID, expect.any(Function));
    expect(state.events).toHaveLength(1);
    expect(flows.loadFlow).toHaveBeenCalledExactlyOnceWith(process.cwd(), 'feature');
  });

  it('allows help, h, version and prototype field names after the ID', () => {
    const result = capture([
      'next',
      ID,
      '--verdict=pass',
      '--help=',
      '--h=value',
      '--version=0',
      '--constructor=-text',
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it.each([
    ['review', '--verdict=pass'],
    ['--unknown', 'value'],
    ['--verdict'],
    ['--verdict=pass', '--verdict', 'fail'],
    ['--verdict=pass', '--note', '-text'],
    ['--verdict=pass', '-x', 'value'],
    ['--verdict=pass', '-h', 'value'],
  ])('rejects malformed outcomes inside the update without a preliminary read (%#)', (...args) => {
    expect(capture(['next', ID, ...args])).toMatchObject({ code: 2, stdout: '' });
    expect(store.loadRun).not.toHaveBeenCalled();
  });

  it.each([[], ['--verdict='], ['--verdict=other']])(
    'reports semantic errors as code 1 (%#)',
    (...args) => {
      const result = capture(['next', ID, ...args]);
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain('verdict');
      expect(result.stderr).not.toContain('Usage:');
    },
  );

  it('uses the schema of the actual state passed to the update', () => {
    vi.mocked(store.updateRun).mockImplementation((_root, _id, update) => update(moved()));
    expect(capture(['next', ID, '--summary=Done.'])).toEqual({
      code: 0,
      stdout: `Run ${ID} is finished.\n`,
      stderr: '',
    });
    expect(capture(['next', ID, '--verdict=pass'])).toMatchObject({ code: 2, stdout: '' });
  });

  it('reports a finished run before parsing outcome flags', () => {
    vi.mocked(store.updateRun).mockImplementation((_root, _id, update) => update(finished()));
    expect(capture(['next', ID, '--unknown'])).toEqual({
      code: 1,
      stdout: '',
      stderr: `stepan: Run ${ID} is finished.\n`,
    });
    expect(flows.loadFlow).not.toHaveBeenCalled();
  });

  it('prepares the response before persistence and never reloads the flow after saving', () => {
    vi.mocked(store.updateRun).mockImplementation((_root, _id, update) => {
      const saved = update(state);
      vi.mocked(flows.loadFlow).mockImplementation(() => {
        throw new Error('flow removed after write');
      });
      return saved;
    });
    expect(capture(['next', ID, '--verdict=pass', '--note=saved'])).toMatchObject({
      code: 0,
      stderr: '',
    });
    expect(flows.loadFlow).toHaveBeenCalledTimes(1);
  });

  it('prints no prepared response if persistence fails', () => {
    vi.mocked(store.updateRun).mockImplementation((_root, _id, update) => {
      update(state);
      throw new Error('write failed');
    });
    expect(capture(['next', ID, '--verdict=pass'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'stepan: write failed\n',
    });
  });

  it('refuses an invalid target before returning an update to the store', () => {
    vi.mocked(flows.loadFlow).mockReturnValue({
      ...flow,
      steps: Object.fromEntries(Object.entries(flow.steps).filter(([id]) => id === 'review')),
    });
    expect(capture(['next', ID, '--verdict=pass'])).toMatchObject({ code: 1, stdout: '' });
  });
});

describe('state commands', () => {
  it('reads current without a graph and includes the ID', () => {
    expect(capture(['current', ID])).toEqual({
      code: 0,
      stderr: '',
      stdout: `Run: ${ID}\nStep: review\n\nReview TASK-1.\n\nstepan next ${ID} --verdict <pass|fail> [--note "<text>"] [--help "<text>"] [--h "<text>"] [--version "<text>"] [--constructor "<text>"] [--x "<text>"]\n`,
    });
    expect(store.loadRun).toHaveBeenCalledWith('isolated-root', ID);
  });

  it('reports completion without printing an instruction', () => {
    vi.mocked(store.loadRun).mockReturnValue(finished());
    expect(capture(['current', ID])).toEqual({
      code: 0,
      stdout: `Run ${ID} is finished.\n`,
      stderr: '',
    });
    expect(flows.loadFlow).not.toHaveBeenCalled();
  });

  it('guards an unknown current step', () => {
    vi.mocked(store.loadRun).mockReturnValue({
      ...state,
      events: [{ type: 'started', step: 'missing', at: '2026-11-05T10:00:00.000Z' }],
    });
    const result = capture(['current', ID]);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain('unknown current step');
    expect(result.stderr).toContain(ID);
    expect(result.stderr).toContain('feature');
  });

  it('deletes a named run without loading or validating its state', () => {
    expect(capture(['rm', ID])).toEqual({ code: 0, stdout: `Run ${ID} deleted.\n`, stderr: '' });
    expect(store.removeRun).toHaveBeenCalledWith('isolated-root', ID);
    expect(store.loadRun).not.toHaveBeenCalled();
  });

  it('lists active or all runs', () => {
    expect(capture(['runs']).stdout).toBe('No active runs.\n');
    expect(store.listRuns).toHaveBeenLastCalledWith('isolated-root', false);
    expect(capture(['runs', '--all']).stdout).toBe('No runs.\n');
    expect(store.listRuns).toHaveBeenLastCalledWith('isolated-root', true);
    expect(flows.loadFlow).not.toHaveBeenCalled();
  });

  it.each(['current', 'next'])(
    'includes run and flow context when loading fails for %s',
    (command) => {
      vi.mocked(flows.loadFlow).mockImplementation(() => {
        throw new Error('missing flow.yaml');
      });
      const result = capture([command, ID]);
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain(`Run ${ID}, flow 'feature': missing flow.yaml`);
    },
  );

  it.each([
    { args: ['current', ID], method: 'loadRun' },
    { args: ['next', ID], method: 'updateRun' },
    { args: ['rm', ID], method: 'removeRun' },
    { args: ['runs'], method: 'listRuns' },
  ] as const)('prints no success output when $method fails', ({ args, method }) => {
    vi.mocked(store[method]).mockImplementation(() => {
      throw new Error('I/O failed');
    });
    expect(capture([...args])).toEqual({ code: 1, stdout: '', stderr: 'stepan: I/O failed\n' });
  });
});
