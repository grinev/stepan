import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateFlow } from './flow.js';
import {
  removeRun,
  listRuns,
  loadRun,
  saveStart,
  updateRun,
  validateRun,
  validateRunId,
} from './run-store.js';
import { advanceRun, type RunState } from './run.js';

// Native ESM exports cannot be spied on directly; keep real I/O behind configurable facades.
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
}));

const ID = 'a7c93f2b';
const OTHER = 'b7c93f2b';
const flow = validateFlow({
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
function state(): RunState {
  return {
    version: 1,
    id: ID,
    flowName: 'feature',
    task: 'TASK-1',
    step: 'first',
    finished: false,
    flow,
    outcomes: {},
  };
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
function path(root: string, id = ID): string {
  return join(root, '.stepan/runs', `${id}.json`);
}
function lock(root: string, id = ID): string {
  return join(root, '.stepan/runs', `${id}.lock`);
}
function put(root: string, text = JSON.stringify(state())): void {
  mkdirSync(join(root, '.stepan/runs'), { recursive: true });
  writeFileSync(path(root), text);
}

describe('validateRun', () => {
  it.each(['', 'Context\nwith two lines'])('retains snapshot descriptions (%#)', (description) => {
    const run = { ...state(), flow: { ...flow, description } };
    expect(validateRun(run)).toEqual(run);
  });

  it('accepts snapshots and completed outcomes', () => {
    expect(validateRun(state())).toEqual(state());
    const value = { ...state(), finished: true, outcomes: { first: { note: 'saved' }, last: {} } };
    expect(validateRun(value)).toEqual(value);
  });

  it.each([
    [null, 'run'],
    [{ ...state(), version: 99 }, 'version'],
    [{ ...state(), id: null }, 'run.id'],
    [{ ...state(), id: '../escape' }, 'hex'],
    [{ ...state(), flowName: '' }, 'flowName'],
    [{ ...state(), task: '' }, 'task'],
    [{ ...state(), finished: 'yes' }, 'finished'],
    [{ ...state(), flow: null }, 'flow'],
    [{ ...state(), flow: { ...flow, description: null } }, 'flow.description'],
    [{ ...state(), step: 'constructor' }, 'step'],
    [{ ...state(), outcomes: null }, 'outcomes'],
    [{ ...state(), outcomes: { missing: {} } }, 'unknown step'],
    [{ ...state(), outcomes: { first: [] } }, 'outcomes.first'],
    [{ ...state(), outcomes: { first: { extra: 'x' } } }, 'unknown field'],
  ])('rejects invalid state (%#)', (value, message) => {
    expect(() => validateRun(value)).toThrow(message);
  });

  it.each([{}, { verdict: '' }, { verdict: 1 }, { verdict: 'fail' }])(
    'validates stored outcomes against their snapshot (%#)',
    (outcome) => {
      const graph = validateFlow({
        start: 'first',
        steps: {
          first: {
            instruction: '',
            outcome: { verdict: { type: 'enum', values: ['pass'], required: true } },
          },
        },
      });
      expect(() =>
        validateRun({ ...state(), flow: graph, outcomes: { first: outcome } }),
      ).toThrow();
    },
  );

  it('does not treat inherited values as stored outcome fields', () => {
    const graph = validateFlow({
      start: 'first',
      steps: {
        first: { instruction: '', outcome: { constructor: { type: 'string', required: true } } },
      },
    });
    expect(() => validateRun({ ...state(), flow: graph, outcomes: { first: {} } })).toThrow(
      'constructor: required',
    );
  });
});

describe('addressed storage', () => {
  it.each(['', '../escape', '..\\escape', ID.toUpperCase(), 'a7c93f2', 'a7c93f2bg', 'g7c93f2b'])(
    'rejects unsafe or noncanonical ID %s',
    (id) => {
      const directory = root();
      expect(() => {
        validateRunId(id);
      }).toThrow('hex');
      expect(() => loadRun(directory, id)).toThrow('hex');
      expect(() => updateRun(directory, id, (run) => run)).toThrow('hex');
      expect(() => {
        removeRun(directory, id);
      }).toThrow('hex');
      expect(readdirSync(directory)).toEqual([]);
    },
  );

  it('accepts all valid lowercase hex IDs, including zero', () => {
    expect(() => {
      validateRunId('00000000');
    }).not.toThrow();
    expect(() => {
      validateRunId('abcdef12');
    }).not.toThrow();
  });

  it.each([false, true])('reads without writing (finished=%s)', (finished) => {
    const directory = root();
    const text = JSON.stringify({ ...state(), finished });
    put(directory, text);
    expect(loadRun(directory, ID)).toEqual({ ...state(), finished });
    expect(readFileSync(path(directory), 'utf8')).toBe(text);
    expect(readdirSync(join(directory, '.stepan/runs'))).toEqual([`${ID}.json`]);
  });

  it('creates independent files and preserves finished runs', () => {
    const directory = root();
    put(directory, JSON.stringify({ ...state(), finished: true }));
    const before = readFileSync(path(directory), 'utf8');
    const one = saveStart(directory, flow, 'feature', 'TASK-1');
    const two = saveStart(directory, flow, 'feature', 'TASK-1');
    expect(one.id).not.toBe(two.id);
    expect(loadRun(directory, one.id)).toEqual(one);
    expect(readFileSync(path(directory), 'utf8')).toBe(before);
    expect(listRuns(directory)).toHaveLength(2);
    expect(listRuns(directory, true)).toHaveLength(3);
  });

  it('never overwrites an ID collision', () => {
    const directory = root();
    put(directory);
    const before = readFileSync(path(directory), 'utf8');
    vi.spyOn(crypto, 'randomBytes').mockImplementation(() => Buffer.from(ID, 'hex'));
    expect(() => saveStart(directory, flow, 'feature', 'new task')).toThrow('after 10 attempts');
    expect(readFileSync(path(directory), 'utf8')).toBe(before);
  });

  it('retries a collision and creates a different run without overwriting the first', () => {
    const directory = root();
    put(directory);
    const before = readFileSync(path(directory), 'utf8');
    vi.spyOn(crypto, 'randomBytes')
      .mockImplementationOnce(() => Buffer.from(ID, 'hex'))
      .mockImplementationOnce(() => Buffer.from(OTHER, 'hex'));
    expect(saveStart(directory, flow, 'feature', 'new task').id).toBe(OTHER);
    expect(readFileSync(path(directory), 'utf8')).toBe(before);
    expect(loadRun(directory, OTHER).task).toBe('new task');
  });

  it('reports missing state without creating directories', () => {
    const directory = root();
    for (const action of [
      () => loadRun(directory, ID),
      () => updateRun(directory, ID, (run) => run),
      () => {
        removeRun(directory, ID);
      },
    ]) {
      expect(action).toThrow('No run found');
      expect(existsSync(join(directory, '.stepan'))).toBe(false);
    }
    expect(listRuns(directory)).toEqual([]);
    mkdirSync(join(directory, '.stepan/runs'), { recursive: true });
    expect(() => updateRun(directory, ID, (run) => run)).toThrow('No run found');
    expect(() => {
      removeRun(directory, ID);
    }).toThrow('No run found');
    expect(readdirSync(join(directory, '.stepan/runs'))).toEqual([]);
  });

  it.each([
    '{invalid',
    JSON.stringify({ ...state(), version: 99 }),
    JSON.stringify({ ...state(), step: 'missing' }),
    JSON.stringify({ ...state(), id: OTHER }),
  ])('refuses damaged state without changing it (%#)', (text) => {
    const directory = root();
    put(directory, text);
    expect(() => loadRun(directory, ID)).toThrow(path(directory));
    expect(() => updateRun(directory, ID, (run) => run)).toThrow(path(directory));
    expect(() => listRuns(directory)).toThrow(path(directory));
    expect(readFileSync(path(directory), 'utf8')).toBe(text);
    expect(existsSync(lock(directory))).toBe(false);
    removeRun(directory, ID);
    expect(existsSync(path(directory))).toBe(false);
  });

  it('reports an unreadable run path and preserves it', () => {
    const directory = root();
    mkdirSync(path(directory), { recursive: true });
    expect(() => loadRun(directory, ID)).toThrow(path(directory));
    expect(() => updateRun(directory, ID, (run) => run)).toThrow(path(directory));
    expect(() => {
      removeRun(directory, ID);
    }).toThrow();
    expect(readdirSync(path(directory))).toEqual([]);
    expect(existsSync(lock(directory))).toBe(false);
  });

  it('lists in ID order, filters finished runs and ignores locks', () => {
    const directory = root();
    put(directory);
    writeFileSync(
      path(directory, OTHER),
      JSON.stringify({ ...state(), id: OTHER, finished: true }),
    );
    writeFileSync(lock(directory), 'busy');
    expect(listRuns(directory).map((run) => run.id)).toEqual([ID]);
    expect(listRuns(directory, true).map((run) => run.id)).toEqual([ID, OTHER]);
  });

  it('reports an invalid run filename without hiding or changing files', () => {
    const directory = root();
    put(directory);
    const before = loadBytes(directory);
    const invalid = join(directory, '.stepan/runs/invalid.json');
    writeFileSync(invalid, 'keep invalid file');
    expect(() => listRuns(directory)).toThrow(`${invalid}: invalid run filename`);
    expect(readFileSync(invalid, 'utf8')).toBe('keep invalid file');
    expect(loadBytes(directory)).toBe(before);
  });

  it('reports a non-directory run location instead of returning an empty list', () => {
    const directory = root();
    mkdirSync(join(directory, '.stepan'));
    const runs = join(directory, '.stepan/runs');
    writeFileSync(runs, 'not a directory');
    expect(() => listRuns(directory)).toThrow();
    expect(readFileSync(runs, 'utf8')).toBe('not a directory');
  });

  it('reports a non-collision creation failure without retrying or changing existing runs', () => {
    const directory = root();
    put(directory);
    const before = loadBytes(directory);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('Write denied'), { code: 'EACCES' });
    });
    expect(() => saveStart(directory, flow, 'feature', 'new task')).toThrow('Write denied');
    expect(write).toHaveBeenCalledTimes(1);
    expect(loadBytes(directory)).toBe(before);
    expect(readdirSync(join(directory, '.stepan/runs'))).toEqual([`${ID}.json`]);
  });

  it.each([false, true])('removes a selected run (finished=%s)', (finished) => {
    const directory = root();
    put(directory, JSON.stringify({ ...state(), finished }));
    const other = saveStart(directory, flow, 'feature', 'other');
    const before = readFileSync(path(directory, other.id), 'utf8');
    removeRun(directory, ID);
    expect(existsSync(path(directory))).toBe(false);
    expect(readFileSync(path(directory, other.id), 'utf8')).toBe(before);
    expect(existsSync(lock(directory))).toBe(false);
  });
});

function loadBytes(directory: string): string {
  return readFileSync(path(directory), 'utf8');
}

describe('locked updates', () => {
  it('saves transitions and completion, releasing the lock on failure too', () => {
    const directory = root();
    put(directory);
    expect(updateRun(directory, ID, (run) => advanceRun(run, { note: 'value' }))).toMatchObject({
      step: 'last',
      outcomes: { first: { note: 'value' } },
    });
    const finished = updateRun(directory, ID, (run) => advanceRun(run, {}));
    expect(finished.finished).toBe(true);
    const before = loadBytes(directory);
    expect(() => updateRun(directory, ID, (run) => advanceRun(run, {}))).toThrow('is finished');
    expect(loadBytes(directory)).toBe(before);
    expect(existsSync(lock(directory))).toBe(false);
  });

  it('reads and parses the actual current state after acquiring its lock', () => {
    const directory = root();
    put(directory);
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const descriptor = open(...args);
      if (args[0] === lock(directory)) put(directory, JSON.stringify({ ...state(), step: 'last' }));
      return descriptor;
    });
    updateRun(directory, ID, (run) => {
      expect(run.step).toBe('last');
      expect(existsSync(lock(directory))).toBe(true);
      return advanceRun(run, {});
    });
    expect(loadRun(directory, ID).finished).toBe(true);
  });

  it('blocks competing writers for the same run but not other runs or starts', () => {
    const directory = root();
    put(directory);
    const other = saveStart(directory, flow, 'feature', 'other');
    updateRun(directory, ID, (run) => {
      expect(() => updateRun(directory, ID, (value) => value)).toThrow('Another command');
      expect(() => {
        removeRun(directory, ID);
      }).toThrow('Another command');
      expect(existsSync(lock(directory))).toBe(true);
      updateRun(directory, other.id, (value) => advanceRun(value, {}));
      removeRun(directory, other.id);
      expect(saveStart(directory, flow, 'feature', 'new').id).not.toBe(ID);
      return advanceRun(run, {});
    });
    expect(existsSync(lock(directory))).toBe(false);
  });

  it('preserves bytes and releases its lock on callback errors or identity changes', () => {
    const directory = root();
    put(directory);
    for (const update of [
      (run: RunState) => advanceRun(run, { extra: 'x' }),
      (run: RunState) => ({ ...run, id: OTHER }),
      () => {
        throw new Error('Usage error');
      },
    ]) {
      const before = loadBytes(directory);
      expect(() => updateRun(directory, ID, update)).toThrow();
      expect(loadBytes(directory)).toBe(before);
      expect(existsSync(lock(directory))).toBe(false);
    }
  });

  it('never removes another writer’s lock', () => {
    const directory = root();
    put(directory);
    const before = loadBytes(directory);
    writeFileSync(lock(directory), 'busy');
    expect(() => updateRun(directory, ID, (run) => run)).toThrow('Another command');
    expect(() => {
      removeRun(directory, ID);
    }).toThrow('Another command');
    expect(readFileSync(lock(directory), 'utf8')).toBe('busy');
    expect(loadBytes(directory)).toBe(before);
  });

  it('releases the lock on a write failure without claiming success', () => {
    const directory = root();
    put(directory);
    const before = loadBytes(directory);
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (args[0] === path(directory)) throw new Error('Write failed');
        write(...args);
      },
    );
    expect(() => updateRun(directory, ID, (run) => advanceRun(run, {}))).toThrow('Write failed');
    expect(loadBytes(directory)).toBe(before);
    expect(existsSync(lock(directory))).toBe(false);
  });
});
