import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { record, validateFlow, type Flow } from './flow.js';
import { advanceRun, validateOutcome, type RunState } from './run.js';

export function validateRun(value: unknown): RunState {
  const run = record(value, 'run');
  if (run.version !== 1) throw new Error(`Unsupported run version: ${String(run.version)}`);
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
  return { version: 1, task: run.task, step: run.step, finished: run.finished, flow, outcomes };
}

function readRun(path: string): RunState | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error(
      `Cannot read run ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    const value: unknown = JSON.parse(text);
    return validateRun(value);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export function loadRun(root: string): RunState {
  const path = join(root, '.stepan', 'run.json');
  const run = readRun(path);
  if (run === undefined) throw new Error(`No run found: ${path}`);
  return run;
}

/** Both writers hold the same lock across reading, deciding and saving. */
function withRunLock(root: string, action: () => RunState): RunState {
  const lock = join(root, '.stepan', 'start.lock');
  let descriptor: number;
  try {
    descriptor = openSync(lock, 'wx');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `Another command holds ${lock}. If a writer crashed, confirm no start or next is running before removing the lock.`,
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

export function saveStart(root: string, flow: Flow, task: string): RunState {
  const directory = join(root, '.stepan');
  const path = join(directory, 'run.json');
  mkdirSync(directory, { recursive: true });
  return withRunLock(root, () => {
    const previous = readRun(path);
    if (previous !== undefined && !previous.finished)
      throw new Error(`A run is already live: ${path}`);
    const run: RunState = {
      version: 1,
      task,
      step: flow.start,
      finished: false,
      flow,
      outcomes: {},
    };
    writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, {
      flag: previous === undefined ? 'wx' : 'w',
    });
    return run;
  });
}

export function saveNext(root: string, step: string, outcome: Record<string, string>): RunState {
  return withRunLock(root, () => {
    const run = advanceRun(loadRun(root), step, outcome);
    writeFileSync(join(root, '.stepan', 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    return run;
  });
}
