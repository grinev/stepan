import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './main.js';
import * as store from './run-store.js';
import * as roots from './write-root.js';

function capture(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

describe('run', () => {
  it('prints usage when called without arguments', () => {
    const result = capture([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: stepan');
  });

  it('prints the package version', () => {
    const result = capture(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects an unknown command with a usage error', () => {
    const result = capture(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });

  it('prints start help without reading a flow or writing state', () => {
    expect(capture(['start', '--help'])).toEqual({
      code: 0,
      stdout: 'Usage: stepan start <flow> <task>\n',
      stderr: '',
    });
  });

  it.each([
    { args: ['start'] },
    { args: ['start', 'feature', ''] },
    { args: ['start', 'feature', 'task', 'extra'] },
    { args: ['start', '--help', '-h'] },
    { args: ['start', '--unknown'] },
  ])('rejects malformed start arguments (%#)', ({ args }) => {
    const result = capture(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: stepan start');
  });
});

describe('current', () => {
  const state: store.RunState = {
    version: 1,
    task: 'TASK-1',
    step: 'review',
    finished: false,
    flow: {
      start: 'plan',
      steps: {
        plan: { instruction: 'Plan.', outcome: {}, transitions: [{ to: 'review' }] },
        review: { instruction: 'Review.', outcome: {}, transitions: [] },
      },
    },
    outcomes: {},
  };

  beforeEach(() => {
    vi.spyOn(roots, 'writeRoot').mockReturnValue('isolated-root');
    vi.spyOn(store, 'loadRun').mockReturnValue(state);
  });
  afterEach(() => vi.restoreAllMocks());

  it('reads the current step from the resolved root without the graph', () => {
    expect(capture(['current'])).toEqual({
      code: 0,
      stdout: 'Review.\n\nstepan next review\n',
      stderr: '',
    });
    expect(roots.writeRoot).toHaveBeenCalledWith(process.cwd());
    expect(store.loadRun).toHaveBeenCalledWith('isolated-root');
  });

  it('reports a finished run instead of printing its step', () => {
    vi.mocked(store.loadRun).mockReturnValue({ ...state, finished: true });
    expect(capture(['current'])).toEqual({
      code: 0,
      stdout: 'Run is finished.\n',
      stderr: '',
    });
  });

  it('reports read failures without a stack trace', () => {
    vi.mocked(store.loadRun).mockImplementation(() => {
      throw new Error('Cannot read run');
    });
    expect(capture(['current'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'stepan: Cannot read run\n',
    });
  });

  it('guards against an unknown current step', () => {
    vi.mocked(store.loadRun).mockReturnValue({ ...state, step: 'missing' });
    expect(capture(['current'])).toEqual({
      code: 1,
      stdout: '',
      stderr: "stepan: Unknown current step 'missing'\n",
    });
  });

  it.each(['-h', '--help'])('prints %s without reading state', (flag) => {
    expect(capture(['current', flag])).toEqual({
      code: 0,
      stdout: 'Usage: stepan current\n',
      stderr: '',
    });
    expect(roots.writeRoot).not.toHaveBeenCalled();
    expect(store.loadRun).not.toHaveBeenCalled();
  });

  it.each([
    ['extra'],
    ['--', 'extra'],
    ['--unknown'],
    ['--help=true'],
    ['--help', '-h'],
    ['-hh'],
    ['--help', 'extra'],
  ])('rejects malformed arguments without reading state (%#)', (...args) => {
    const result = capture(['current', ...args]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: stepan current');
    expect(roots.writeRoot).not.toHaveBeenCalled();
    expect(store.loadRun).not.toHaveBeenCalled();
  });
});
