import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { record, validateFlow, type Flow } from './flow.js';
import { validateOutcome, type RunState } from './run.js';

export function validateRunId(id: string): void {
  if (!/^[0-9a-f]{8}$/.test(id)) {
    throw new Error('Expected a run ID of 8 lowercase hex characters');
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function runPath(root: string, id: string): string {
  validateRunId(id);
  return join(root, '.stepan', 'runs', `${id}.json`);
}

export function validateRun(value: unknown): RunState {
  const run = record(value, 'run');
  if (run.version !== 1) throw new Error(`Unsupported run version: ${String(run.version)}`);
  if (typeof run.id !== 'string') throw new Error('run.id: expected a run ID');
  validateRunId(run.id);
  if (typeof run.flowName !== 'string' || run.flowName.length === 0)
    throw new Error('run.flowName: expected a non-empty string');
  if (typeof run.task !== 'string' || run.task.length === 0)
    throw new Error('run.task: expected a non-empty string');
  if (typeof run.finished !== 'boolean') throw new Error('run.finished: expected a boolean');
  const flow = validateFlow(run.flow);
  if (typeof run.step !== 'string' || !Object.hasOwn(flow.steps, run.step)) {
    throw new Error('run.step: expected a step in the snapshot');
  }
  const outcomes = Object.fromEntries(
    Object.entries(record(run.outcomes, 'run.outcomes')).map(
      ([id, raw]): [string, Record<string, string>] => {
        if (!Object.hasOwn(flow.steps, id)) throw new Error(`run.outcomes: unknown step '${id}'`);
        const fields = flow.steps[id]?.outcome ?? {};
        return [id, validateOutcome(raw, fields, `run.outcomes.${id}`)];
      },
    ),
  );
  return {
    version: 1,
    id: run.id,
    flowName: run.flowName,
    task: run.task,
    step: run.step,
    finished: run.finished,
    flow,
    outcomes,
  };
}

function readRun(root: string, id: string): RunState {
  const path = runPath(root, id);
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const run = validateRun(value);
    if (run.id !== id) throw new Error(`run.id does not match filename: ${run.id}`);
    return run;
  } catch (error) {
    if (missing(error)) throw new Error(`No run found: ${path}`, { cause: error });
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export function loadRun(root: string, id: string): RunState {
  validateRunId(id);
  return readRun(root, id);
}

/** A lock belongs to one run; acquiring it never creates directories. */
function withRunLock<T>(root: string, id: string, action: () => T): T {
  const path = runPath(root, id);
  const lock = join(root, '.stepan', 'runs', `${id}.lock`);
  let descriptor: number;
  try {
    descriptor = openSync(lock, 'wx');
  } catch (error) {
    if (missing(error)) throw new Error(`No run found: ${path}`, { cause: error });
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `Another command holds ${lock}. If a writer crashed, confirm no next or rm for this run is running before removing the lock.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

export function saveStart(root: string, flow: Flow, flowName: string, task: string): RunState {
  for (let attempt = 0; attempt < 10; attempt++) {
    const run = validateRun({
      version: 1,
      id: randomBytes(4).toString('hex'),
      flowName,
      task,
      step: flow.start,
      finished: false,
      flow,
      outcomes: {},
    });
    mkdirSync(join(root, '.stepan', 'runs'), { recursive: true });
    try {
      writeFileSync(runPath(root, run.id), `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
      return run;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  throw new Error('Cannot allocate a unique run ID after 10 attempts');
}

export function updateRun(root: string, id: string, update: (run: RunState) => RunState): RunState {
  validateRunId(id);
  return withRunLock(root, id, () => {
    const run = validateRun(update(readRun(root, id)));
    if (run.id !== id) throw new Error('Cannot change run ID');
    writeFileSync(runPath(root, id), `${JSON.stringify(run, null, 2)}\n`);
    return run;
  });
}

export function removeRun(root: string, id: string): void {
  validateRunId(id);
  withRunLock(root, id, () => {
    const path = runPath(root, id);
    try {
      unlinkSync(path);
    } catch (error) {
      if (missing(error)) throw new Error(`No run found: ${path}`, { cause: error });
      throw error;
    }
  });
}

export function listRuns(root: string, all = false): RunState[] {
  let names: string[];
  try {
    names = readdirSync(join(root, '.stepan', 'runs'));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const id = name.slice(0, -5);
      try {
        validateRunId(id);
      } catch (error) {
        throw new Error(`${join(root, '.stepan', 'runs', name)}: invalid run filename`, {
          cause: error,
        });
      }
      return readRun(root, id);
    })
    .filter((run) => all || !run.finished);
}
