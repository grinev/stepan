import { describe, expect, it } from 'vitest';
import { validateFlow } from './flow.js';
import { advanceRun, currentStep, validateOutcome, type RunState } from './run.js';

function state(
  definition: unknown = {
    start: 'first',
    steps: {
      first: { instruction: 'First.', transitions: [{ to: 'last' }] },
      last: { instruction: 'Last.' },
    },
  },
): RunState {
  const flow = validateFlow(definition);
  return {
    version: 1,
    id: 'a7c93f2b',
    flowName: 'feature',
    task: 'TASK-1',
    step: flow.start,
    finished: false,
    flow,
    outcomes: {},
  };
}

describe('validateOutcome', () => {
  const fields = {
    text: { type: 'string' as const, required: true },
    note: { type: 'string' as const },
    verdict: { type: 'enum' as const, values: ['pass', 'fail'], required: true },
    reason: { type: 'enum' as const, values: ['small', 'large'] },
  };

  it('keeps strings unchanged and permits omitted or empty optional strings', () => {
    const values = { text: '  ', verdict: 'pass', note: '' };
    expect(validateOutcome(values, fields, 'outcome')).toEqual(values);
    expect(validateOutcome(values, fields, 'outcome')).not.toBe(values);
    expect(
      validateOutcome({ text: '0', verdict: 'fail', reason: 'large' }, fields, 'outcome'),
    ).toEqual({ text: '0', verdict: 'fail', reason: 'large' });
  });

  it.each([
    [null, 'outcome'],
    [[], 'outcome'],
    [{ verdict: 'pass' }, 'outcome.text: required'],
    [{ text: '', verdict: 'pass' }, 'outcome.text: required'],
    [{ text: 'x' }, 'outcome.verdict: required'],
    [{ text: 'x', verdict: '' }, 'outcome.verdict: required'],
    [{ text: 'x', verdict: 'other' }, 'outcome.verdict: invalid enum'],
    [{ text: 'x', verdict: 'pass', reason: '' }, 'outcome.reason: invalid enum'],
    [{ text: 'x', verdict: 'pass', note: 1 }, 'outcome.note: unknown field or non-string'],
    [{ text: 'x', verdict: 'pass', extra: 'x' }, 'outcome.extra: unknown field'],
    [{ text: 'x', verdict: 'pass', toString: 'x' }, 'outcome.toString: unknown field'],
  ])('rejects an invalid outcome with its field context (%#)', (values, message) => {
    expect(() => validateOutcome(values, fields, 'outcome')).toThrow(message);
  });

  it('requires own properties and supports prototype property names', () => {
    const schema = { constructor: { type: 'string' as const, required: true } };
    expect(() => validateOutcome({}, schema, 'outcome')).toThrow('constructor: required');
    expect(validateOutcome({ constructor: 'value' }, schema, 'outcome')).toEqual({
      constructor: 'value',
    });
  });
});

describe('currentStep', () => {
  it('returns the current step and refuses a finished run', () => {
    const run = state();
    expect(currentStep(run)).toBe(run.flow.steps.first);
    expect(() => currentStep({ ...run, finished: true })).toThrow(`Run ${run.id} is finished.`);
  });

  it.each(['missing', 'constructor'])('guards an invalid current step %s', (step) => {
    expect(() => currentStep({ ...state(), step })).toThrow('Unknown current step');
  });
});

describe('advanceRun', () => {
  it('enters but does not finish a final step, then stores its empty outcome on completion', () => {
    const before = state();
    const copy = structuredClone(before);
    const moved = advanceRun(before, {});
    expect(moved).toEqual({ ...before, step: 'last', outcomes: { first: {} } });
    expect(before).toEqual(copy);
    const finished = advanceRun(moved, {});
    expect(finished).toEqual({ ...moved, finished: true, outcomes: { first: {}, last: {} } });
    expect(moved.finished).toBe(false);
    expect(() => advanceRun(finished, {})).toThrow('is finished.');
  });

  it('validates an outcome before finishing a final step', () => {
    const before = state({
      start: 'last',
      steps: {
        last: { instruction: 'Last.', outcome: { text: { type: 'string', required: true } } },
      },
    });
    const copy = structuredClone(before);
    expect(() => advanceRun(before, {})).toThrow('text: required');
    expect(before).toEqual(copy);
    expect(advanceRun(before, { text: 'Done.' })).toMatchObject({
      finished: true,
      step: 'last',
      outcomes: { last: { text: 'Done.' } },
    });
  });

  it('selects the first matching conditional, otherwise the default', () => {
    const run = state({
      start: 'review',
      steps: {
        review: {
          instruction: 'Review.',
          outcome: { verdict: { type: 'enum', values: ['pass', 'fail'] } },
          transitions: [
            { when: { verdict: 'fail' }, to: 'review' },
            { when: { verdict: 'fail' }, to: 'last' },
            { to: 'last' },
          ],
        },
        last: { instruction: 'Last.' },
      },
    });
    expect(advanceRun(run, { verdict: 'fail' }).step).toBe('review');
    expect(advanceRun(run, { verdict: 'pass' }).step).toBe('last');
    expect(advanceRun(run, {}).step).toBe('last');
  });

  it('does not treat missing optional or inherited fields as matching values', () => {
    const run = state({
      start: 'first',
      steps: {
        first: {
          instruction: 'First.',
          outcome: { note: { type: 'string' }, constructor: { type: 'string' } },
          transitions: [
            { when: { note: '' }, to: 'first' },
            { when: { constructor: 'value' }, to: 'first' },
            { to: 'last' },
          ],
        },
        last: { instruction: 'Last.' },
      },
    });
    expect(advanceRun(run, {}).step).toBe('last');
    expect(advanceRun(run, { note: '' }).step).toBe('first');
    expect(advanceRun(run, { constructor: 'value' }).step).toBe('first');
  });

  it('replaces a revisited outcome rather than merging optional fields', () => {
    const before = state({
      start: 'first',
      steps: {
        first: {
          instruction: 'First.',
          outcome: { text: { type: 'string' }, note: { type: 'string' } },
          transitions: [{ to: 'second' }],
        },
        second: { instruction: 'Second.', transitions: [{ to: 'first' }] },
      },
    });
    const one = advanceRun(before, { text: 'old', note: 'remove' });
    const two = advanceRun(one, {});
    const three = advanceRun(two, { text: 'new' });
    expect(three.outcomes).toEqual({ first: { text: 'new' }, second: {} });
    expect(three.flow).toBe(before.flow);
    expect(three.task).toBe(before.task);
    expect(two.outcomes.first).toEqual({ text: 'old', note: 'remove' });
  });

  it('leaves state unchanged when no transition matches', () => {
    const run = state({
      start: 'first',
      steps: {
        first: {
          instruction: 'First.',
          outcome: { note: { type: 'string' } },
          transitions: [{ when: { note: 'yes' }, to: 'first' }],
        },
      },
    });
    const copy = structuredClone(run);
    expect(() => advanceRun(run, { note: 'no' })).toThrow('no matching transition');
    expect(run).toEqual(copy);
  });
});
