import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateFlow, type Flow } from './flow.js';
import { saveStart, validateRun, type RunState } from './run-store.js';

const flow = validateFlow({ start: 'first', steps: { first: { instruction: 'Instruction.' } } });
function run(): RunState {
  return { version: 1, task: 'TASK-1', step: 'first', finished: false, flow, outcomes: {} };
}

describe('validateRun', () => {
  it('accepts a valid snapshot, including completed outcomes', () => {
    expect(validateRun(run())).toEqual(run());
    const snapshot = {
      ...run(),
      flow: validateFlow({
        start: 'first',
        steps: {
          first: {
            instruction: '',
            outcome: { verdict: { type: 'enum', values: ['pass'], required: true } },
          },
        },
      }),
      outcomes: { first: { verdict: 'pass' } },
      finished: true,
    };
    expect(validateRun(snapshot)).toEqual(snapshot);
  });

  it.each([
    [null, 'run'],
    [{ ...run(), version: 2 }, 'version'],
    [{ ...run(), task: '' }, 'task'],
    [{ ...run(), finished: 'yes' }, 'finished'],
    [{ ...run(), flow: null }, 'flow'],
    [{ ...run(), step: 'constructor' }, 'step'],
    [{ ...run(), outcomes: null }, 'outcomes'],
    [{ ...run(), outcomes: { missing: {} } }, 'unknown step'],
    [{ ...run(), outcomes: { first: [] } }, 'outcomes.first'],
    [{ ...run(), outcomes: { first: { extra: 'x' } } }, 'unknown field'],
  ])('rejects malformed or unsupported run state (%#)', (value, message) => {
    expect(() => validateRun(value)).toThrow(message);
  });

  it.each([
    [{}, 'required'],
    [{ verdict: '' }, 'required'],
    [{ verdict: 1 }, 'non-string'],
    [{ verdict: 'fail' }, 'enum'],
  ])('rejects invalid stored outcomes (%#)', (values, message) => {
    const snapshot = {
      ...run(),
      flow: validateFlow({
        start: 'first',
        steps: {
          first: {
            instruction: '',
            outcome: { verdict: { type: 'enum', values: ['pass'], required: true } },
          },
        },
      }),
      outcomes: { first: values },
    };
    expect(() => validateRun(snapshot)).toThrow(message);
  });

  it('does not mistake inherited properties for required stored values', () => {
    const snapshot = {
      ...run(),
      flow: validateFlow({
        start: 'first',
        steps: {
          first: {
            instruction: '',
            outcome: { constructor: { type: 'string', required: true } },
          },
        },
      }),
      outcomes: { first: {} },
    };
    expect(() => validateRun(snapshot)).toThrow('constructor: required value is missing');
  });
});

describe('saveStart', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  function root(): string {
    const directory = mkdtempSync(join(tmpdir(), 'stepan-store-'));
    directories.push(directory);
    return directory;
  }

  it('creates a snapshot and refuses a live run without changing bytes', () => {
    const directory = root();
    expect(saveStart(directory, flow, 'TASK-1')).toEqual(run());
    const path = join(directory, '.stepan/run.json');
    const before = readFileSync(path, 'utf8');
    expect(() => saveStart(directory, flow, 'TASK-2')).toThrow('already live');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(directory, '.stepan/start.lock'))).toBe(false);
  });

  it('replaces a finished run', () => {
    const directory = root();
    mkdirSync(join(directory, '.stepan'));
    writeFileSync(
      join(directory, '.stepan/run.json'),
      JSON.stringify({ ...run(), finished: true }),
    );
    expect(saveStart(directory, flow, 'TASK-2').task).toBe('TASK-2');
  });

  it.each([
    '{invalid',
    JSON.stringify({ ...run(), version: 99 }),
    JSON.stringify({ finished: true }),
  ])('does not overwrite an unreadable run (%#)', (text) => {
    const directory = root();
    mkdirSync(join(directory, '.stepan'));
    const path = join(directory, '.stepan/run.json');
    writeFileSync(path, text);
    expect(() => saveStart(directory, flow, 'TASK-2')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(existsSync(join(directory, '.stepan/start.lock'))).toBe(false);
  });

  it('preserves an unreadable run path and releases the lock', () => {
    const directory = root();
    mkdirSync(join(directory, '.stepan/run.json'), { recursive: true });
    expect(() => saveStart(directory, flow, 'TASK-2')).toThrow();
    expect(existsSync(join(directory, '.stepan/run.json'))).toBe(true);
    expect(existsSync(join(directory, '.stepan/start.lock'))).toBe(false);
  });

  it.each([false, true])(
    'holds the lock during initial creation or replacement (finished=%s)',
    (finished) => {
      const directory = root();
      if (finished) {
        mkdirSync(join(directory, '.stepan'));
        writeFileSync(
          join(directory, '.stepan/run.json'),
          JSON.stringify({ ...run(), finished: true }),
        );
      }
      let called = false;
      const reentrant: Flow = {
        start: 'first',
        steps: {
          first: {
            get instruction() {
              called = true;
              expect(() => saveStart(directory, flow, 'racing start')).toThrow('Another start');
              return 'Instruction.';
            },
            outcome: {},
            transitions: [],
          },
        },
      };
      saveStart(directory, reentrant, 'winner');
      expect(called).toBe(true);
      expect(
        validateRun(JSON.parse(readFileSync(join(directory, '.stepan/run.json'), 'utf8'))).task,
      ).toBe('winner');
    },
  );

  it('does not remove another invocation’s lock', () => {
    const directory = root();
    mkdirSync(join(directory, '.stepan'));
    const lock = join(directory, '.stepan/start.lock');
    writeFileSync(lock, 'busy');
    expect(() => saveStart(directory, flow, 'TASK-1')).toThrow('Another start');
    expect(readFileSync(lock, 'utf8')).toBe('busy');
  });
});
