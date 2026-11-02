import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './main.js';
import * as store from './run-store.js';
import { advanceRun, type RunState } from './run.js';
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

describe('next', () => {
  const state: RunState = {
    version: 1,
    task: 'TASK-1',
    step: 'review',
    finished: false,
    outcomes: {},
    flow: {
      start: 'review',
      steps: {
        review: {
          instruction: 'Review.',
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
          instruction: 'Finish.',
          outcome: { summary: { type: 'string', required: true } },
          transitions: [],
        },
      },
    },
  };

  beforeEach(() => {
    vi.spyOn(roots, 'writeRoot').mockReturnValue('isolated-root');
    vi.spyOn(store, 'loadRun').mockReturnValue(state);
    vi.spyOn(store, 'saveNext').mockImplementation((_root, id, outcome) =>
      advanceRun(state, id, outcome),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('parses both long value forms and prints the saved next step', () => {
    const result = capture(['next', 'review', '--verdict=pass', '--note', 'текст с пробелами']);
    expect(result).toEqual({
      code: 0,
      stdout: 'Finish.\n\nstepan next finish --summary "<text>"\n',
      stderr: '',
    });
    expect(roots.writeRoot).toHaveBeenCalledWith(process.cwd());
    expect(store.loadRun).toHaveBeenCalledWith('isolated-root');
    expect(store.saveNext).toHaveBeenCalledWith('isolated-root', 'review', {
      verdict: 'pass',
      note: 'текст с пробелами',
    });
  });

  it('does not reserve help, h, version or prototype property names after the step', () => {
    expect(
      capture([
        'next',
        'review',
        '--verdict',
        'pass',
        '--help',
        'value',
        '--h',
        'value',
        '--version',
        'value',
        '--constructor',
        'value',
      ]).code,
    ).toBe(0);
    expect(store.saveNext).toHaveBeenCalledWith('isolated-root', 'review', {
      verdict: 'pass',
      help: 'value',
      h: 'value',
      version: 'value',
      constructor: 'value',
    });
  });

  it('keeps empty optional and leading-dash string values', () => {
    expect(capture(['next', 'review', '--verdict=pass', '--note=-text', '--help=']).code).toBe(0);
    expect(store.saveNext).toHaveBeenCalledWith('isolated-root', 'review', {
      verdict: 'pass',
      note: '-text',
      help: '',
    });
  });

  it.each(['-h', '--help'])('prints standalone %s without reading state', (flag) => {
    expect(capture(['next', flag])).toEqual({
      code: 0,
      stdout: 'Usage: stepan next <step> [--<field> <value>...]\n',
      stderr: '',
    });
    expect(store.loadRun).not.toHaveBeenCalled();
    expect(roots.writeRoot).not.toHaveBeenCalled();
    expect(store.saveNext).not.toHaveBeenCalled();
  });

  it.each([[], [''], ['--verdict', 'pass'], ['--help', 'extra'], ['-h', '--help']])(
    'rejects a missing or misplaced step without reading state (%#)',
    (...args) => {
      expect(capture(['next', ...args])).toMatchObject({ code: 2, stdout: '' });
      expect(store.loadRun).not.toHaveBeenCalled();
      expect(roots.writeRoot).not.toHaveBeenCalled();
      expect(store.saveNext).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['--verdict', 'pass', 'extra'],
    ['--unknown', 'value'],
    ['--verdict'],
    ['--verdict=pass', '--verdict', 'fail'],
    ['--verdict', 'pass', '--note', '-text'],
    ['--verdict', 'pass', '-x', 'value'],
    ['--verdict', 'pass', '-h', 'value'],
  ])('rejects malformed outcome arguments without saving (%#)', (...args) => {
    const result = capture(['next', 'review', ...args]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: stepan next');
    expect(store.saveNext).not.toHaveBeenCalled();
  });

  it.each([[], ['--verdict='], ['--verdict=other']])(
    'reports semantic outcome errors with exit code 1 (%#)',
    (...args) => {
      const result = capture(['next', 'review', ...args]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('verdict');
      expect(result.stderr).not.toContain('Usage:');
    },
  );

  it('finishes a final step only after saving its outcome', () => {
    const last = { ...state, step: 'finish' };
    vi.mocked(store.loadRun).mockReturnValue(last);
    vi.mocked(store.saveNext).mockImplementation((_root, id, outcome) =>
      advanceRun(last, id, outcome),
    );
    expect(capture(['next', 'finish', '--summary', 'Done.'])).toEqual({
      code: 0,
      stdout: 'Run is finished.\n',
      stderr: '',
    });
  });

  it('refuses a finished run before parsing outcome flags', () => {
    vi.mocked(store.loadRun).mockReturnValue({ ...state, finished: true });
    expect(capture(['next', 'review', '--unknown'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'stepan: Run is finished.\n',
    });
    expect(store.saveNext).not.toHaveBeenCalled();
  });

  it('refuses a mismatched step before parsing outcome flags', () => {
    const result = capture(['next', 'finish', '--unknown']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("current: 'review'");
    expect(store.saveNext).not.toHaveBeenCalled();
  });

  it.each(['loadRun', 'saveNext'] as const)('prints no success output when %s fails', (method) => {
    vi.mocked(store[method]).mockImplementation(() => {
      throw new Error('I/O failed');
    });
    expect(capture(['next', 'review', '--verdict=pass'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'stepan: I/O failed\n',
    });
  });

  it('does not save an outdated step from the preliminary read', () => {
    vi.mocked(store.saveNext).mockImplementation((_root, id, outcome) =>
      advanceRun({ ...state, step: 'finish' }, id, outcome),
    );
    const result = capture(['next', 'review', '--verdict=pass']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("current: 'finish'");
  });
});

describe('current', () => {
  const state: RunState = {
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
