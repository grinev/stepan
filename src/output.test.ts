import { describe, expect, it } from 'vitest';
import { graphOverview, stepOutput } from './output.js';
import { validateFlow, type Step } from './flow.js';
import type { RunState } from './run.js';

const context: Pick<RunState, 'task' | 'outcomes'> = {
  task: 'TASK-1',
  outcomes: { plan: { path: 'docs/plan.md', note: '', verdict: 'pass' } },
};

function render(instruction: string, data = context): string {
  return stepOutput('review', { instruction, outcome: {}, transitions: [] }, data);
}

describe('output', () => {
  it('shows ordered conditional edges, defaults and final steps', () => {
    const flow = validateFlow({
      start: 'review',
      steps: {
        review: {
          instruction: 'Review.',
          outcome: { verdict: { type: 'enum', values: ['pass', 'fail'] } },
          transitions: [{ when: { verdict: 'fail' }, to: 'review' }, { to: 'finish' }],
        },
        finish: { instruction: 'Finish.' },
      },
    });
    expect(graphOverview(flow)).toBe('review -> verdict="fail" -> review, finish\nfinish (final)');
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
      'Review.\n\nstepan next review --plan "<text>" --verdict <pass|fail> [--findings "<text>"] [--extra <yes>]\n',
    );
  });

  it('adds a newline if needed and handles a final step without fields', () => {
    expect(
      stepOutput('finish', { instruction: '{{task}}', outcome: {}, transitions: [] }, context),
    ).toBe('TASK-1\n\nstepan next finish\n');
  });

  it('substitutes repeated task and outcome references, including an enum value', () => {
    expect(
      render('{{task}}: {{steps.plan.outcome.path}}; {{task}}; {{steps.plan.outcome.verdict}}.'),
    ).toBe('TASK-1: docs/plan.md; TASK-1; pass.\n\nstepan next review\n');
  });

  it('supports step and field names with hyphens, underscores and digits', () => {
    expect(
      render('{{steps.plan-2_v3.outcome.file-4_path}}', {
        task: 'TASK-1',
        outcomes: { 'plan-2_v3': { 'file-4_path': 'saved' } },
      }),
    ).toBe('saved\n\nstepan next review\n');
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
    expect(render(text)).toBe(`${text}\n\nstepan next review\n`);
  });

  it('leaves unvisited outcomes unresolved', () => {
    expect(render('{{steps.plan.outcome.path}}', { task: 'TASK-1', outcomes: {} })).toBe(
      '{{steps.plan.outcome.path}}\n\nstepan next review\n',
    );
  });

  it('distinguishes an empty stored string from a missing value', () => {
    expect(render('Before {{steps.plan.outcome.note}}after')).toBe(
      'Before after\n\nstepan next review\n',
    );
  });

  it('resolves own prototype-named properties but leaves inherited properties unresolved', () => {
    const text =
      '{{steps.constructor.outcome.toString}} / {{steps.plan.outcome.constructor}} / {{steps.toString.outcome.path}}';
    expect(render(text)).toBe(`${text}\n\nstepan next review\n`);
    expect(
      render(text, {
        task: 'TASK-1',
        outcomes: {
          constructor: { toString: 'own value' },
          plan: { constructor: 'own field' },
        },
      }),
    ).toBe('own value / own field / {{steps.toString.outcome.path}}\n\nstepan next review\n');
  });

  it('inserts task and outcome text once and preserves literal replacement metacharacters', () => {
    const task = '{{steps.plan.outcome.path}} $& $1 $$ \\ "задача"';
    const path = '{{task}} $& $1 $$ \\ "план"\nsecond line';
    expect(
      render('{{task}}\n{{steps.plan.outcome.path}}', { task, outcomes: { plan: { path } } }),
    ).toBe(`${task}\n${path}\n\nstepan next review\n`);
  });

  it.each(['value', 'value\n', ''])('formats the newline after substitution (%#)', (path) => {
    expect(
      render('{{steps.plan.outcome.path}}', { task: 'TASK-1', outcomes: { plan: { path } } }),
    ).toBe(`${path}${path.endsWith('\n') ? '' : '\n'}\nstepan next review\n`);
  });

  it('keeps the snapshot and context unchanged and substitutes only the instruction', () => {
    const step: Step = {
      instruction: '{{task}}: {{steps.plan.outcome.path}}',
      outcome: { verdict: { type: 'enum', values: ['{{task}}'], required: true } },
      transitions: [],
    };
    const before = structuredClone({ step, context });
    expect(stepOutput('review', step, context)).toBe(
      'TASK-1: docs/plan.md\n\nstepan next review --verdict <{{task}}>\n',
    );
    expect({ step, context }).toEqual(before);
  });
});
