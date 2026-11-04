import { describe, expect, it } from 'vitest';
import { runsOutput, startOutput, stepOutput } from './output.js';
import { validateFlow, type Step } from './flow.js';
import type { RunState } from './run.js';

const ID = 'a7c93f2b';
const HEADER = `Run: ${ID}\nStep: review\n\n`;
const EXIT = `stepan next ${ID}`;
const context: Pick<RunState, 'id' | 'task' | 'outcomes'> = {
  id: ID,
  task: 'TASK-1',
  outcomes: { plan: { path: 'docs/plan.md', note: '', verdict: 'pass' } },
};

function render(instruction: string, data = context): string {
  return stepOutput('review', { instruction, outcome: {}, transitions: [] }, data);
}

describe('output', () => {
  it.each([
    [undefined, 'Step output'],
    ['', 'Step output'],
    ['Context {{task}}', 'Context {{task}}\n\nStep output'],
    ['First\nSecond\n', 'First\nSecond\n\nStep output'],
    ['Context\n\n', 'Context\n\n\nStep output'],
  ])('formats the literal optional description (%#)', (description, expected) => {
    expect(startOutput(description, 'Step output')).toBe(expected);
  });

  it('renders all field types and optionality in the exit template', () => {
    expect(
      stepOutput(
        'review',
        {
          instruction: 'Review.\n',
          transitions: [],
          outcome: {
            plan: { type: 'string', required: true },
            verdict: { type: 'enum', values: ['pass', 'fail'], required: true },
            findings: { type: 'string' },
            extra: { type: 'enum', values: ['yes'], required: false },
          },
        },
        context,
      ),
    ).toBe(
      `${HEADER}Review.\n\n${EXIT} --plan "<text>" --verdict <pass|fail> [--findings "<text>"] [--extra <yes>]\n`,
    );
  });

  it('adds a newline if needed and handles a final step without fields', () => {
    expect(
      stepOutput('finish', { instruction: '{{task}}', outcome: {}, transitions: [] }, context),
    ).toBe(`Run: ${ID}\nStep: finish\n\nTASK-1\n\n${EXIT}\n`);
  });

  it('substitutes repeated task and outcome references, including an enum value', () => {
    expect(
      render('{{task}}: {{steps.plan.outcome.path}}; {{task}}; {{steps.plan.outcome.verdict}}.'),
    ).toBe(`${HEADER}TASK-1: docs/plan.md; TASK-1; pass.\n\n${EXIT}\n`);
  });

  it('supports step and field names with hyphens, underscores and digits', () => {
    expect(
      render('{{steps.plan-2_v3.outcome.file-4_path}}', {
        id: ID,
        task: 'TASK-1',
        outcomes: { 'plan-2_v3': { 'file-4_path': 'saved' } },
      }),
    ).toBe(`${HEADER}saved\n\n${EXIT}\n`);
  });

  it.each([
    '{{unknown}}',
    '{{steps.missing.outcome.path}}',
    '{{steps.plan.outcome.missing}}',
    '{{steps.plan.path}}',
    '{{ task }}',
    '{{steps.plan.outcome.path }}',
    '{{steps.1plan.outcome.path}}',
    '{{steps.plan.outcome.1path}}',
    '{{task',
    'plain text',
    '',
  ])('preserves unresolved or unsupported text (%#)', (text) => {
    expect(render(text)).toBe(`${HEADER}${text}\n\n${EXIT}\n`);
  });

  it('leaves unvisited outcomes unresolved', () => {
    expect(render('{{steps.plan.outcome.path}}', { id: ID, task: 'TASK-1', outcomes: {} })).toBe(
      `${HEADER}{{steps.plan.outcome.path}}\n\n${EXIT}\n`,
    );
  });

  it('distinguishes an empty stored string from a missing value', () => {
    expect(render('Before {{steps.plan.outcome.note}}after')).toBe(
      `${HEADER}Before after\n\n${EXIT}\n`,
    );
  });

  it('resolves own prototype-named properties but leaves inherited properties unresolved', () => {
    const text =
      '{{steps.constructor.outcome.toString}} / {{steps.plan.outcome.constructor}} / {{steps.toString.outcome.path}}';
    expect(render(text)).toBe(`${HEADER}${text}\n\n${EXIT}\n`);
    expect(
      render(text, {
        id: ID,
        task: 'TASK-1',
        outcomes: {
          constructor: { toString: 'own value' },
          plan: { constructor: 'own field' },
        },
      }),
    ).toBe(`${HEADER}own value / own field / {{steps.toString.outcome.path}}\n\n${EXIT}\n`);
  });

  it('inserts task and outcome text once and preserves literal replacement metacharacters', () => {
    const task = '{{steps.plan.outcome.path}} $& $1 $$ \\ "задача"';
    const path = '{{task}} $& $1 $$ \\ "план"\nsecond line';
    expect(
      render('{{task}}\n{{steps.plan.outcome.path}}', {
        id: ID,
        task,
        outcomes: { plan: { path } },
      }),
    ).toBe(`${HEADER}${task}\n${path}\n\n${EXIT}\n`);
  });

  it.each(['value', 'value\n', ''])('formats the newline after substitution (%#)', (path) => {
    expect(
      render('{{steps.plan.outcome.path}}', {
        id: ID,
        task: 'TASK-1',
        outcomes: { plan: { path } },
      }),
    ).toBe(`${HEADER}${path}${path.endsWith('\n') ? '' : '\n'}\n${EXIT}\n`);
  });

  it('keeps the snapshot and context unchanged and substitutes only the instruction', () => {
    const step: Step = {
      instruction: '{{task}}: {{steps.plan.outcome.path}}',
      outcome: { verdict: { type: 'enum', values: ['{{task}}'], required: true } },
      transitions: [],
    };
    const before = structuredClone({ step, context });
    expect(stepOutput('review', step, context)).toBe(
      `${HEADER}TASK-1: docs/plan.md\n\n${EXIT} --verdict <{{task}}>\n`,
    );
    expect({ step, context }).toEqual(before);
  });

  it('prints empty lists and escapes multiline table cells', () => {
    expect(runsOutput([], false)).toBe('No active runs.\n');
    expect(runsOutput([], true)).toBe('No runs.\n');
    const flow = validateFlow({ start: 'done', steps: { done: { instruction: '' } } });
    const run: RunState = {
      version: 1,
      id: ID,
      flowName: 'feature',
      task: 'one\ntwo\t"three"',
      step: 'done',
      finished: false,
      flow,
      outcomes: {},
    };
    const output = runsOutput([run, { ...run, finished: true }], true);
    expect(output.split('\n')).toHaveLength(4);
    expect(output).toContain(JSON.stringify(run.task));
    expect(output).toContain('"active"');
    expect(output).toContain('"finished"');
  });
});
