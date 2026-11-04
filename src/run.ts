import { record, type Flow, type OutcomeField, type Step } from './flow.js';

export type RunEvent =
  | { type: 'started'; at: string; step: string }
  | {
      type: 'transitioned';
      at: string;
      from: string;
      to: string;
      outcome: Record<string, string>;
    }
  | { type: 'finished'; at: string; step: string; outcome: Record<string, string> };

export interface RunState {
  version: 2;
  id: string;
  flowName: string;
  task: string;
  events: RunEvent[];
}

export interface RunView extends RunState {
  step: string;
  finished: boolean;
  outcomes: Record<string, Record<string, string>>;
}

/** Reduce recorded facts without replaying them against a potentially edited flow. */
export function runView(run: RunState): RunView {
  let step = '';
  let finished = false;
  const outcomes: Record<string, Record<string, string>> = {};
  for (const event of run.events) {
    if (event.type === 'started') step = event.step;
    else {
      const source = event.type === 'transitioned' ? event.from : event.step;
      Object.defineProperty(outcomes, source, {
        value: { ...event.outcome },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (event.type === 'transitioned') step = event.to;
      else finished = true;
    }
  }
  return { ...run, step, finished, outcomes };
}

export function validateOutcome(
  value: unknown,
  fields: Record<string, OutcomeField>,
  where: string,
): Record<string, string> {
  const values = Object.fromEntries(Object.entries(record(value, where)));
  for (const [key, entry] of Object.entries(values)) {
    if (!Object.hasOwn(fields, key) || typeof entry !== 'string') {
      throw new Error(`${where}.${key}: unknown field or non-string value`);
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    const entry = Object.hasOwn(values, key) ? values[key] : undefined;
    if (field.required === true && (entry === undefined || entry === '')) {
      throw new Error(`${where}.${key}: required value is missing`);
    }
    if (typeof entry === 'string' && field.type === 'enum' && !field.values.includes(entry)) {
      throw new Error(`${where}.${key}: invalid enum value (expected ${field.values.join('|')})`);
    }
  }
  return values as Record<string, string>;
}

export function currentStep(run: RunState, flow: Flow): Step {
  const view = runView(run);
  if (view.finished) throw new Error(`Run ${run.id} is finished.`);
  const id = view.step;
  const step = Object.hasOwn(flow.steps, id) ? flow.steps[id] : undefined;
  if (step === undefined)
    throw new Error(`Run ${run.id}, flow '${run.flowName}': unknown current step '${id}'`);
  return step;
}

export function advanceRun(
  run: RunState,
  flow: Flow,
  value: Record<string, string>,
  at = new Date().toISOString(),
): RunState {
  const id = runView(run).step;
  const step = currentStep(run, flow);
  const outcome = validateOutcome(value, step.outcome, `steps.${id}.outcome`);
  if (step.transitions.length === 0)
    return { ...run, events: [...run.events, { type: 'finished', at, step: id, outcome }] };

  const transition = step.transitions.find(
    ({ when }) =>
      when === undefined ||
      Object.entries(when).every(
        ([field, expected]) => Object.hasOwn(outcome, field) && outcome[field] === expected,
      ),
  );
  if (transition === undefined) throw new Error(`Step '${id}': no matching transition`);
  return {
    ...run,
    events: [...run.events, { type: 'transitioned', at, from: id, to: transition.to, outcome }],
  };
}
