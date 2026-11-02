import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateFlow, type Flow } from './flow.js';
import { loadRun, saveNext, saveStart, validateRun } from './run-store.js';
import type { RunState } from './run.js';

// Native ESM exports cannot be spied on directly; keep real I/O behind a configurable facade.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

const flow = validateFlow({ start: 'first', steps: { first: { instruction: 'Instruction.' } } });
function run(): RunState {
  return { version: 1, task: 'TASK-1', step: 'first', finished: false, flow, outcomes: {} };
}

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'stepan-store-'));
  directories.push(directory);
  return directory;
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

describe('loadRun', () => {
  it.each([false, true])('reads a snapshot without writing (finished=%s)', (finished) => {
    const directory = root();
    const state = { ...run(), finished };
    const text = JSON.stringify(state);
    mkdirSync(join(directory, '.stepan'));
    const path = join(directory, '.stepan/run.json');
    writeFileSync(path, text);
    expect(loadRun(directory)).toEqual(state);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(readdirSync(join(directory, '.stepan'))).toEqual(['run.json']);
  });

  it('reports a missing run without creating its directory', () => {
    const directory = root();
    expect(() => loadRun(directory)).toThrow('No run found');
    expect(existsSync(join(directory, '.stepan'))).toBe(false);
  });

  it.each([
    ['{invalid', 'JSON'],
    [JSON.stringify({ ...run(), version: 99 }), 'Unsupported run version'],
    [JSON.stringify({ ...run(), step: 'missing' }), 'run.step'],
    [JSON.stringify({ finished: true }), 'version'],
  ])('refuses invalid state without changing its bytes (%#)', (text, message) => {
    const directory = root();
    mkdirSync(join(directory, '.stepan'));
    const path = join(directory, '.stepan/run.json');
    writeFileSync(path, text);
    expect(() => loadRun(directory)).toThrow(message);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(readdirSync(join(directory, '.stepan'))).toEqual(['run.json']);
  });

  it('reports an unreadable run path without changing it', () => {
    const directory = root();
    const path = join(directory, '.stepan/run.json');
    mkdirSync(path, { recursive: true });
    expect(() => loadRun(directory)).toThrow('Cannot read run');
    expect(readdirSync(path)).toEqual([]);
    expect(readdirSync(join(directory, '.stepan'))).toEqual(['run.json']);
  });
});

describe('saveStart', () => {
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
              expect(() => saveStart(directory, flow, 'racing start')).toThrow('Another command');
              expect(() => saveNext(directory, 'first', {})).toThrow('Another command');
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
    expect(() => saveStart(directory, flow, 'TASK-1')).toThrow('Another command');
    expect(readFileSync(lock, 'utf8')).toBe('busy');
  });
});

describe('saveNext', () => {
  const graph = validateFlow({
    start: 'first',
    steps: {
      first: {
        instruction: 'First.',
        outcome: { note: { type: 'string' } },
        transitions: [{ to: 'last' }],
      },
      last: { instruction: 'Last.' },
    },
  });

  it('saves a transition and completion as validated state and releases the lock', () => {
    const directory = root();
    saveStart(directory, graph, 'TASK-1');
    const next = saveNext(directory, 'first', { note: 'value' });
    expect(next).toMatchObject({
      step: 'last',
      finished: false,
      outcomes: { first: { note: 'value' } },
    });
    expect(loadRun(directory)).toEqual(next);
    expect(saveNext(directory, 'last', {})).toMatchObject({
      finished: true,
      outcomes: { last: {} },
    });
    const path = join(directory, '.stepan/run.json');
    const finished = readFileSync(path, 'utf8');
    expect(() => saveNext(directory, 'last', {})).toThrow('Run is finished.');
    expect(readFileSync(path, 'utf8')).toBe(finished);
    expect(fs.readdirSync(join(directory, '.stepan'))).toEqual(['run.json']);
  });

  it('rereads the current state after acquiring the lock', () => {
    const directory = root();
    const old = saveStart(directory, graph, 'TASK-1');
    expect(loadRun(directory).step).toBe('first');
    const text = JSON.stringify({ ...old, step: 'last' });
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const descriptor = open(...args);
      if (args[0] === join(directory, '.stepan/start.lock')) {
        expect(existsSync(join(directory, '.stepan/start.lock'))).toBe(true);
        writeFileSync(join(directory, '.stepan/run.json'), text);
      }
      return descriptor;
    });
    expect(() => saveNext(directory, 'first', {})).toThrow('not current');
    expect(readFileSync(join(directory, '.stepan/run.json'), 'utf8')).toBe(text);
    expect(existsSync(join(directory, '.stepan/start.lock'))).toBe(false);
  });

  it('blocks both writers while applying the outcome', () => {
    const directory = root();
    saveStart(directory, graph, 'TASK-1');
    let called = false;
    const outcome = {
      get note() {
        called = true;
        expect(() => saveStart(directory, graph, 'racing start')).toThrow('Another command');
        expect(() => saveNext(directory, 'first', {})).toThrow('Another command');
        return 'winner';
      },
    };
    saveNext(directory, 'first', outcome);
    expect(called).toBe(true);
    expect(loadRun(directory).outcomes.first).toEqual({ note: 'winner' });
  });

  it.each([
    { step: 'other', outcome: {}, message: 'not current' },
    { step: 'first', outcome: { extra: 'x' }, message: 'unknown field' },
  ])('preserves bytes and releases its lock on rejection (%#)', ({ step, outcome, message }) => {
    const directory = root();
    saveStart(directory, graph, 'TASK-1');
    const path = join(directory, '.stepan/run.json');
    const before = readFileSync(path, 'utf8');
    expect(() => saveNext(directory, step, outcome)).toThrow(message);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(directory, '.stepan/start.lock'))).toBe(false);
  });

  it.each([
    '{invalid',
    JSON.stringify({ ...run(), version: 99 }),
    JSON.stringify({ finished: true }),
  ])('does not overwrite invalid stored state (%#)', (text) => {
    const directory = root();
    mkdirSync(join(directory, '.stepan'));
    const path = join(directory, '.stepan/run.json');
    writeFileSync(path, text);
    expect(() => saveNext(directory, 'first', {})).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(existsSync(join(directory, '.stepan/start.lock'))).toBe(false);
  });

  it('refuses missing state without creating its directory', () => {
    const directory = root();
    expect(() => saveNext(directory, 'first', {})).toThrow();
    expect(existsSync(join(directory, '.stepan'))).toBe(false);
    mkdirSync(join(directory, '.stepan'));
    expect(() => saveNext(directory, 'first', {})).toThrow('No run found');
    expect(fs.readdirSync(join(directory, '.stepan'))).toEqual([]);
  });

  it('refuses an unreadable run path and releases its lock', () => {
    const directory = root();
    const path = join(directory, '.stepan/run.json');
    mkdirSync(path, { recursive: true });
    expect(() => saveNext(directory, 'first', {})).toThrow('Cannot read run');
    expect(fs.readdirSync(path)).toEqual([]);
    expect(existsSync(join(directory, '.stepan/start.lock'))).toBe(false);
  });

  it('does not change a busy lock or run', () => {
    const directory = root();
    saveStart(directory, graph, 'TASK-1');
    const path = join(directory, '.stepan/run.json');
    const before = readFileSync(path, 'utf8');
    const lock = join(directory, '.stepan/start.lock');
    writeFileSync(lock, 'busy');
    expect(() => saveNext(directory, 'first', {})).toThrow('Another command');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readFileSync(lock, 'utf8')).toBe('busy');
  });

  it('releases its lock on a write failure without claiming success', () => {
    const directory = root();
    saveStart(directory, graph, 'TASK-1');
    const path = join(directory, '.stepan/run.json');
    const before = readFileSync(path, 'utf8');
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (args[0] === path) throw new Error('Write failed');
        write(...args);
      },
    );
    expect(() => saveNext(directory, 'first', {})).toThrow('Write failed');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(directory, '.stepan/start.lock'))).toBe(false);
  });
});
