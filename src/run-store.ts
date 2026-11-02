import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { record, validateFlow, type Flow } from './flow.js';

export interface RunState {
  version: 1;
  task: string;
  step: string;
  finished: boolean;
  flow: Flow;
  outcomes: Record<string, Record<string, string>>;
}

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
        const values = record(raw, `run.outcomes.${id}`);
        for (const [key, entry] of Object.entries(values)) {
          if (!Object.hasOwn(fields, key) || typeof entry !== 'string') {
            throw new Error(`run.outcomes.${id}.${key}: unknown field or non-string value`);
          }
        }
        for (const [key, field] of Object.entries(fields)) {
          const entry = Object.hasOwn(values, key) ? values[key] : undefined;
          if (field.required === true && (entry === undefined || entry === '')) {
            throw new Error(`run.outcomes.${id}.${key}: required value is missing`);
          }
          if (typeof entry === 'string' && field.type === 'enum' && !field.values.includes(entry)) {
            throw new Error(`run.outcomes.${id}.${key}: invalid enum value`);
          }
        }
        return [id, values as Record<string, string>];
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

/** The lock covers the read as well as the write, including replacement of a finished run. */
export function saveStart(root: string, flow: Flow, task: string): RunState {
  const directory = join(root, '.stepan');
  const path = join(directory, 'run.json');
  const lock = join(directory, 'start.lock');
  mkdirSync(directory, { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(lock, 'wx');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `Another start holds ${lock}. If a start crashed, confirm it is no longer running before removing the lock.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
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
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}
