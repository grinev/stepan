import { describe, expect, it } from 'vitest';
import { validateFlow } from './flow.js';
import { advanceRun, currentStep, runView, validateOutcome, type RunState } from './run.js';

function state(
  definition: unknown = {
    start: 'first',
    steps: {
      first: { instruction: 'First.', transitions: [{ to: 'last' }] },
      last: { instruction: 'Last.' },
    },
  },
) {
  const flow = validateFlow(definition);
  const run: RunState = {
    version: 2,
    id: 'a7c93f2b',
    flowName: 'feature',
    task: 'TASK-1',
    events: [{ type: 'started', at: '2026-11-05T10:00:00.000Z', step: flow.start }],
  };
  return { run, flow };
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
    const { run, flow } = state();
    expect(currentStep(run, flow)).toBe(flow.steps.first);
    const finished = advanceRun(advanceRun(run, flow, {}), flow, {});
    expect(() => currentStep(finished, flow)).toThrow(`Run ${run.id} is finished.`);
  });

  it.each(['missing', 'constructor'])('guards an invalid current step %s', (step) => {
    const { run, flow } = state();
    run.events = [{ type: 'started', at: '2026-11-05T10:00:00.000Z', step }];
    expect(() => currentStep(run, flow)).toThrow(`unknown current step '${step}'`);
  });
});

describe('advanceRun', () => {
  it('enters but does not finish a final step, then stores its empty outcome on completion', () => {
    const { run: before, flow } = state();
    const copy = structuredClone(before);
    const at = '2026-11-05T10:01:00.000Z';
    const moved = advanceRun(before, flow, {}, at);
    expect(moved.events).toEqual([
      ...before.events,
      { type: 'transitioned', at, from: 'first', to: 'last', outcome: {} },
    ]);
    expect(before).toEqual(copy);
    const finished = advanceRun(moved, flow, {}, at);
    expect(finished.events).toEqual([
      ...moved.events,
      { type: 'finished', at, step: 'last', outcome: {} },
    ]);
    expect(runView(finished)).toMatchObject({
      step: 'last',
      finished: true,
      outcomes: { first: {}, last: {} },
    });
    expect(runView(moved).finished).toBe(false);
    expect(() => advanceRun(finished, flow, {})).toThrow('is finished.');
  });

  it('validates an outcome before finishing a final step', () => {
    const { run: before, flow } = state({
      start: 'last',
      steps: {
        last: { instruction: 'Last.', outcome: { text: { type: 'string', required: true } } },
      },
    });
    const copy = structuredClone(before);
    expect(() => advanceRun(before, flow, {})).toThrow('text: required');
    expect(before).toEqual(copy);
    expect(runView(advanceRun(before, flow, { text: 'Done.' }))).toMatchObject({
      finished: true,
      step: 'last',
      outcomes: { last: { text: 'Done.' } },
    });
  });

  it('selects the first matching conditional, otherwise the default', () => {
    const { run, flow } = state({
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
    expect(runView(advanceRun(run, flow, { verdict: 'fail' })).step).toBe('review');
    expect(runView(advanceRun(run, flow, { verdict: 'pass' })).step).toBe('last');
    expect(runView(advanceRun(run, flow, {})).step).toBe('last');
  });

  it('does not treat missing optional or inherited fields as matching values', () => {
    const { run, flow } = state({
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
    expect(runView(advanceRun(run, flow, {})).step).toBe('last');
    expect(runView(advanceRun(run, flow, { note: '' })).step).toBe('first');
    expect(runView(advanceRun(run, flow, { constructor: 'value' })).step).toBe('first');
  });

  it('replaces a revisited outcome rather than merging optional fields', () => {
    const { run: before, flow } = state({
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
    const one = advanceRun(before, flow, { text: 'old', note: 'remove' });
    const two = advanceRun(one, flow, {});
    const three = advanceRun(two, flow, { text: 'new' });
    expect(runView(three).outcomes).toEqual({ first: { text: 'new' }, second: {} });
    expect(three.events.slice(0, -1)).toEqual(two.events);
    expect(three.task).toBe(before.task);
    expect(runView(two).outcomes.first).toEqual({ text: 'old', note: 'remove' });
  });

  it('leaves state unchanged when no transition matches', () => {
    const { run, flow } = state({
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
    expect(() => advanceRun(run, flow, { note: 'no' })).toThrow('no matching transition');
    expect(run).toEqual(copy);
  });

  it('uses the supplied flow without revalidating historical steps or outcomes', () => {
    const { run, flow } = state();
    const moved = advanceRun(run, flow, {});
    const edited = validateFlow({
      start: 'last',
      steps: {
        last: { instruction: 'New.', outcome: { text: { type: 'string' } } },
      },
    });
    expect(currentStep(moved, edited).instruction).toBe('New.');
    const finished = advanceRun(moved, edited, { text: 'line one\nline two' });
    expect(runView(finished).outcomes).toEqual({ first: {}, last: { text: 'line one\nline two' } });
    expect(finished.events.slice(0, -1)).toEqual(moved.events);
  });

  it('reduces prototype-named steps without inherited values or modifying recorded outcomes', () => {
    const { run, flow } = state({
      start: 'constructor',
      steps: {
        constructor: {
          instruction: '',
          outcome: { toString: { type: 'string' } },
          transitions: [{ to: 'constructor' }],
        },
      },
    });
    const moved = advanceRun(run, flow, { toString: 'own' });
    const view = runView(moved);
    expect(Object.hasOwn(runView(run).outcomes, 'constructor')).toBe(false);
    expect(view.outcomes.constructor).toEqual({ toString: 'own' });
    Object.assign(view.outcomes.constructor, { toString: 'changed' });
    expect(runView(moved).outcomes.constructor).toEqual({ toString: 'own' });
  });
});
