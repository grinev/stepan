import { describe, expect, it } from 'vitest';
import { graphOverview, stepOutput } from './output.js';
import { validateFlow } from './flow.js';

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
      stepOutput('review', {
        instruction: 'Review.\n',
        transitions: [],
        outcome: {
          plan: { type: 'string', required: true },
          verdict: { type: 'enum', values: ['pass', 'fail'], required: true },
          findings: { type: 'string' },
          extra: { type: 'enum', values: ['yes'], required: false },
        },
      }),
    ).toBe(
      'Review.\n\nstepan next review --plan "<text>" --verdict <pass|fail> [--findings "<text>"] [--extra <yes>]\n',
    );
  });

  it('adds a newline if needed and handles a final step without fields', () => {
    expect(stepOutput('finish', { instruction: '{{task}}', outcome: {}, transitions: [] })).toBe(
      '{{task}}\n\nstepan next finish\n',
    );
  });
});
