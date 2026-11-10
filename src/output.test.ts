import { describe, expect, it } from 'vitest';
import { runsOutput, startOutput, stepOutput } from './output.js';
import type { Step } from './flow.js';
import type { RunState, RunView } from './run.js';

const ID = 'a7c93f2b';
const HEADER = `Run: ${ID}\nStep: review\n\nInstructions:\n`;
const EXIT = `After completing this step, run:\nstepan next ${ID}`;
const context: Pick<RunView, 'id' | 'task' | 'outcomes'> = {
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
    ['Context {{task}}', 'Flow description:\nContext {{task}}\n\nStep output'],
    ['First\nSecond\n', 'Flow description:\nFirst\nSecond\n\nStep output'],
    ['Context\n\n', 'Flow description:\nContext\n\n\nStep output'],
    [' ', 'Flow description:\n \n\nStep output'],
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
    ).toBe(`Run: ${ID}\nStep: finish\n\nInstructions:\nTASK-1\n\n${EXIT}\n`);
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
    '{{steps.plan.path}}',
    '{{ task }}',
    '{{steps.plan.outcome.path }}',
    '{{steps.1plan.outcome.path}}',
    '{{steps.plan.outcome.1path}}',
    '{{{steps.missing.outcome.value}}}',
    '{{{task}}}',
    '{{unknown {{steps.missing.outcome.value}} }}',
    '{{unknown {{task}} }}',
    '{{unknown {{task}}',
    '{{task',
    'plain text',
    '',
  ])('preserves unsupported text (%#)', (text) => {
    expect(render(text)).toBe(`${HEADER}${text}\n\n${EXIT}\n`);
  });

  it('marks unvisited outcomes as missing', () => {
    expect(render('{{steps.plan.outcome.path}}', { id: ID, task: 'TASK-1', outcomes: {} })).toBe(
      `${HEADER}-\n\n${EXIT}\n`,
    );
  });

  it('marks missing steps and fields with valid names', () => {
    expect(render('{{steps.missing-1_a.outcome.field_2}} / {{steps.plan.outcome.absent}}')).toBe(
      `${HEADER}- / -\n\n${EXIT}\n`,
    );
  });

  it('substitutes adjacent placeholders without treating them as nested', () => {
    expect(render('{{task}}{{steps.missing.outcome.value}}{{steps.plan.outcome.path}}')).toBe(
      `${HEADER}TASK-1-docs/plan.md\n\n${EXIT}\n`,
    );
  });

  it('continues substitution after a nested malformed expression', () => {
    expect(render('{{unknown {{task}} }} {{task}}')).toBe(
      `${HEADER}{{unknown {{task}} }} TASK-1\n\n${EXIT}\n`,
    );
  });

  it('continues on the next line after an unclosed expression', () => {
    expect(render('Example `{{task`\nCurrent: {{task}}')).toBe(
      `${HEADER}Example \`{{task\`\nCurrent: TASK-1\n\n${EXIT}\n`,
    );
  });

  it('substitutes placeholders next to surrounding structural braces', () => {
    expect(render('{"plan":{{steps.plan.outcome.path}}}')).toBe(
      `${HEADER}{"plan":docs/plan.md}\n\n${EXIT}\n`,
    );
  });

  it('distinguishes an empty stored string from a missing value', () => {
    expect(render('Before {{steps.plan.outcome.note}}after')).toBe(
      `${HEADER}Before after\n\n${EXIT}\n`,
    );
    expect(render('{{steps.plan.outcome.note}} / {{steps.plan.outcome.missing}}')).toBe(
      `${HEADER} / -\n\n${EXIT}\n`,
    );
    expect(
      render('{{steps.plan.outcome.note}}', {
        id: ID,
        task: 'TASK-1',
        outcomes: { plan: { note: '-' } },
      }),
    ).toBe(`${HEADER}-\n\n${EXIT}\n`);
  });

  it('resolves own prototype-named properties but marks inherited properties missing', () => {
    const text =
      '{{steps.constructor.outcome.toString}} / {{steps.plan.outcome.constructor}} / {{steps.toString.outcome.path}}';
    expect(render(text)).toBe(`${HEADER}- / - / -\n\n${EXIT}\n`);
    expect(
      render(text, {
        id: ID,
        task: 'TASK-1',
        outcomes: {
          constructor: { toString: 'own value' },
          plan: { constructor: 'own field' },
        },
      }),
    ).toBe(`${HEADER}own value / own field / -\n\n${EXIT}\n`);
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

  it.each(['value', 'value\n', 'первая строка\nвторая строка\n\n', ''])(
    'formats the newline after substitution (%#)',
    (path) => {
      expect(
        render('{{steps.plan.outcome.path}}', {
          id: ID,
          task: 'TASK-1',
          outcomes: { plan: { path } },
        }),
      ).toBe(`${HEADER}${path}${path.endsWith('\n') ? '' : '\n'}\n${EXIT}\n`);
    },
  );

  it('keeps the instruction and context unchanged and substitutes only the instruction', () => {
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
    const run: RunState = {
      version: 2,
      id: ID,
      flowName: 'feature',
      task: 'one\ntwo\t"three"',
      events: [{ type: 'started', step: 'done', at: '2026-11-05T10:00:00.000Z' }],
    };
    const output = runsOutput(
      [
        run,
        {
          ...run,
          events: [
            ...run.events,
            { type: 'finished', step: 'done', at: '2026-11-05T10:01:00.000Z', outcome: {} },
          ],
        },
      ],
      true,
    );
    expect(output.split('\n')).toHaveLength(4);
    expect(output).toContain(JSON.stringify(run.task));
    expect(output).toContain('"active"');
    expect(output).toContain('"finished"');
  });
});
