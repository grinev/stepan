import { record, type Flow, type OutcomeField, type Step } from './flow.js';

export interface RunState {
  version: 1;
  id: string;
  flowName: string;
  task: string;
  step: string;
  finished: boolean;
  flow: Flow;
  outcomes: Record<string, Record<string, string>>;
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

export function currentStep(run: RunState): Step {
  if (run.finished) throw new Error(`Run ${run.id} is finished.`);
  const id = run.step;
  const step = Object.hasOwn(run.flow.steps, id) ? run.flow.steps[id] : undefined;
  if (step === undefined) throw new Error(`Unknown current step '${id}'`);
  return step;
}

export function advanceRun(run: RunState, value: Record<string, string>): RunState {
  const id = run.step;
  const step = currentStep(run);
  const outcome = validateOutcome(value, step.outcome, `steps.${id}.outcome`);
  const outcomes = { ...run.outcomes, [id]: outcome };
  if (step.transitions.length === 0) return { ...run, outcomes, finished: true };

  const transition = step.transitions.find(
    ({ when }) =>
      when === undefined ||
      Object.entries(when).every(
        ([field, expected]) => Object.hasOwn(outcome, field) && outcome[field] === expected,
      ),
  );
  if (transition === undefined) throw new Error(`Step '${id}': no matching transition`);
  return { ...run, step: transition.to, outcomes };
}
