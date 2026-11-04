import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
import { keys, record, type Flow } from './flow.js';
import { runView, type RunEvent, type RunState } from './run.js';

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
  if (run.version !== 2) throw new Error(`Unsupported run version: ${String(run.version)}`);
  keys(run, ['version', 'id', 'flowName', 'task', 'events'], 'run');
  if (typeof run.id !== 'string') throw new Error('run.id: expected a run ID');
  validateRunId(run.id);
  if (typeof run.flowName !== 'string' || run.flowName.length === 0)
    throw new Error('run.flowName: expected a non-empty string');
  if (typeof run.task !== 'string' || run.task.length === 0)
    throw new Error('run.task: expected a non-empty string');
  if (!Array.isArray(run.events) || run.events.length === 0)
    throw new Error('run.events: expected a non-empty array');
  let step: string | undefined;
  let finished = false;
  const events = run.events.map((raw: unknown, index): RunEvent => {
    const where = `run.events[${String(index)}]`;
    const event = record(raw, where);
    if (finished) throw new Error(`${where}: event after finished`);
    if (
      typeof event.at !== 'string' ||
      !Number.isFinite(Date.parse(event.at)) ||
      new Date(event.at).toISOString() !== event.at
    )
      throw new Error(`${where}.at: expected an ISO 8601 UTC timestamp with milliseconds`);
    if (event.type === 'started') {
      keys(event, ['type', 'at', 'step'], where);
      if (index !== 0) throw new Error(`${where}: started must be the first and only start`);
      step = eventName(event.step, `${where}.step`);
      return { type: 'started', at: event.at, step };
    }
    if (step === undefined) throw new Error(`${where}: expected started as the first event`);
    if (event.type !== 'transitioned' && event.type !== 'finished')
      throw new Error(`${where}.type: unknown event type`);
    keys(
      event,
      event.type === 'transitioned'
        ? ['type', 'at', 'from', 'to', 'outcome']
        : ['type', 'at', 'step', 'outcome'],
      where,
    );
    const source = eventName(
      event.type === 'transitioned' ? event.from : event.step,
      `${where}.${event.type === 'transitioned' ? 'from' : 'step'}`,
    );
    if (source !== step)
      throw new Error(`${where}: expected current step '${step}', got '${source}'`);
    const outcome = Object.fromEntries(
      Object.entries(record(event.outcome, `${where}.outcome`)).map(([field, entry]) => {
        eventName(field, `${where}.outcome.${field}`);
        if (typeof entry !== 'string')
          throw new Error(`${where}.outcome.${field}: expected a string`);
        return [field, entry];
      }),
    );
    if (event.type === 'finished') {
      finished = true;
      return { type: 'finished', at: event.at, step, outcome };
    }
    const to = eventName(event.to, `${where}.to`);
    step = to;
    return { type: 'transitioned', at: event.at, from: source, to, outcome };
  });
  return {
    version: 2,
    id: run.id,
    flowName: run.flowName,
    task: run.task,
    events,
  };
}

function eventName(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value))
    throw new Error(`${where}: expected a step or field name`);
  return value;
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
      version: 2,
      id: randomBytes(4).toString('hex'),
      flowName,
      task,
      events: [{ type: 'started', at: new Date().toISOString(), step: flow.start }],
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
    const before = readRun(root, id);
    const run = validateRun(update(structuredClone(before)));
    const { events: previous, ...header } = before;
    const { events, ...updatedHeader } = run;
    if (!isDeepStrictEqual(header, updatedHeader)) throw new Error('Cannot change run header');
    if (events.length !== previous.length + 1 || !isDeepStrictEqual(events.slice(0, -1), previous))
      throw new Error('An update must preserve history and append exactly one event');
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
    .filter((run) => all || !runView(run).finished);
}
