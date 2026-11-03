import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, runCli, runId, runPath, type CliSandbox } from './run-cli.js';

const FLOW = `start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      plan: {type: string, required: true}
      note: {type: string}
    transitions:
      - to: review
  review:
    instruction: review.md
    outcome:
      verdict: {type: enum, values: [pass, fail], required: true}
    transitions:
      - when: {verdict: fail}
        to: plan
      - when: {verdict: pass}
        to: finish
  finish:
    instruction: finish.md
`;
function put(cli: CliSandbox, path: string, text: string): void {
  const file = join(cli.cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function fixture(layout: 'installed' | 'sources' = 'installed'): CliSandbox {
  const cli = createCli(layout);
  put(cli, '.stepan/flows/feature/flow.yaml', FLOW);
  put(cli, '.stepan/flows/feature/plan.md', 'Plan {{task}}.\n');
  put(cli, '.stepan/flows/feature/review.md', 'Review {{steps.plan.outcome.plan}}.\n');
  put(cli, '.stepan/flows/feature/finish.md', 'Finish.\n');
  return cli;
}

describe('stepan start', () => {
  it('snapshots the whole flow and prints the graph, run ID and initial exit template', () => {
    const cli = fixture();
    const result = runCli(['start', 'feature', 'STP-8: задача'], cli);
    const id = runId(result);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      `plan -> review\nreview -> verdict="fail" -> plan, verdict="pass" -> finish\nfinish (final)\n\nRun: ${id}\nStep: plan\n\nPlan STP-8: задача.\n\nstepan next ${id} --plan "<text>" [--note "<text>"]\n`,
    );
    const path = runPath(cli, id);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      id,
      flowName: 'feature',
      task: 'STP-8: задача',
      step: 'plan',
      finished: false,
      outcomes: {},
      flow: {
        start: 'plan',
        steps: {
          plan: {
            instruction: 'Plan {{task}}.\n',
            outcome: { plan: { type: 'string', required: true }, note: { type: 'string' } },
            transitions: [{ to: 'review' }],
          },
          review: {
            instruction: 'Review {{steps.plan.outcome.plan}}.\n',
            outcome: { verdict: { type: 'enum', values: ['pass', 'fail'], required: true } },
            transitions: [
              { when: { verdict: 'fail' }, to: 'plan' },
              { when: { verdict: 'pass' }, to: 'finish' },
            ],
          },
          finish: { instruction: 'Finish.\n', outcome: {}, transitions: [] },
        },
      },
    });
    expect(readdirSync(cli.runsDirectory)).toEqual([`${id}.json`]);
    const before = readFileSync(path, 'utf8');
    put(cli, '.stepan/flows/feature/flow.yaml', 'changed: true');
    put(cli, '.stepan/flows/feature/plan.md', 'Changed instruction.');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it.each(['installed', 'sources'] as const)('writes only to the isolated %s root', (layout) => {
    const cli = fixture(layout);
    const id = runId(runCli(['start', 'feature', 'TASK-1'], cli));
    expect(existsSync(runPath(cli, id))).toBe(true);
    const other =
      layout === 'sources' ? join(cli.cwd, '.stepan/runs') : join(cli.packageRoot, '.dev-data');
    expect(existsSync(other)).toBe(false);
    for (const path of ['.stepan', '.config', 'AppData', '.local'])
      expect(existsSync(join(cli.sandbox, path))).toBe(false);
  });

  it.each(['installed', 'sources'] as const)(
    'does not fall back to a top-level flows directory in %s mode',
    (layout) => {
      const cli = fixture(layout);
      renameSync(join(cli.cwd, '.stepan/flows'), join(cli.cwd, 'flows'));
      const result = runCli(['start', 'feature', 'TASK-1'], cli);
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain(join(cli.cwd, '.stepan/flows/feature/flow.yaml'));
      expect(existsSync(cli.runsDirectory)).toBe(false);
      expect(readFileSync(join(cli.cwd, 'flows/feature/flow.yaml'), 'utf8')).toBe(FLOW);
      expect(readFileSync(join(cli.cwd, 'flows/feature/plan.md'), 'utf8')).toBe('Plan {{task}}.\n');
    },
  );

  it.each(['installed', 'sources'] as const)(
    'uses .stepan/flows when both flow directories exist in %s mode',
    (layout) => {
      const cli = fixture(layout);
      const oldYaml = 'start: old\nsteps:\n  old: {instruction: old.md}\n';
      put(cli, 'flows/feature/flow.yaml', oldYaml);
      put(cli, 'flows/feature/old.md', 'Old instruction.');
      const result = runCli(['start', 'feature', 'TASK-1'], cli);
      const id = runId(result);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Plan TASK-1.');
      expect(result.stdout).not.toContain('Old instruction.');
      expect(existsSync(runPath(cli, id))).toBe(true);
      expect(readFileSync(join(cli.cwd, 'flows/feature/flow.yaml'), 'utf8')).toBe(oldYaml);
      expect(readFileSync(join(cli.cwd, 'flows/feature/old.md'), 'utf8')).toBe('Old instruction.');
    },
  );

  it('supports final steps without outcomes and -- before positional values', () => {
    const cli = fixture();
    put(
      cli,
      '.stepan/flows/-flow/flow.yaml',
      'start: done\nsteps:\n  done: {instruction: done.md, outcome: null, transitions: []}\n',
    );
    put(cli, '.stepan/flows/-flow/done.md', 'Done.');
    const result = runCli(['start', '--', '-flow', '-task'], cli);
    const id = runId(result);
    expect(result.stdout).toBe(
      `done (final)\n\nRun: ${id}\nStep: done\n\nDone.\n\nstepan next ${id}\n`,
    );
    expect(JSON.parse(readFileSync(runPath(cli, id), 'utf8'))).toMatchObject({
      task: '-task',
      flowName: '-flow',
    });
  });

  it('prints enum and optional enum fields', () => {
    const cli = fixture();
    put(
      cli,
      '.stepan/flows/feature/flow.yaml',
      'start: review\nsteps:\n  review:\n    instruction: review.md\n    outcome:\n      verdict: {type: enum, values: [pass, fail], required: true}\n      note: {type: enum, values: [yes, no]}\n',
    );
    const result = runCli(['start', 'feature', 'TASK-1'], cli);
    const id = runId(result);
    expect(result.stdout).toContain(`stepan next ${id} --verdict <pass|fail> [--note <yes|no>]`);
  });

  it.each([
    ['start'],
    ['start', 'feature'],
    ['start', 'feature', ''],
    ['start', 'feature', 'task', 'extra'],
    ['start', 'feature', 'task', '--unknown'],
    ['start', '--help', '--help'],
  ])('reports usage errors without writing state (%#)', (...args) => {
    const cli = fixture();
    const result = runCli(args, cli);
    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toContain('Usage: stepan start');
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });

  it.each([[], ['--help'], ['start', '--help'], ['start', '-h']])(
    'documents start in help (%#)',
    (...args) => {
      const result = runCli(args);
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toContain('start <flow> <task>');
    },
  );

  it.each([
    ['start: [', 'flow.yaml'],
    ['start: plan\nstart: review\nsteps: {}', 'flow.yaml'],
    ['start: !unknown plan\nsteps: {}', 'flow.yaml'],
    ['start: missing\nsteps:\n  plan: {instruction: plan.md}', 'flow.start'],
    ['start: plan\nsteps: {}', 'flow.steps'],
    ['start: plan\nsteps:\n  plan: {instruction: missing.md}', 'steps.plan.instruction'],
    [
      'start: plan\nsteps:\n  plan: {instruction: plan.md}\n  unused: {instruction: missing.md}',
      'steps.unused.instruction',
    ],
    ['start: plan\nsteps:\n  plan: {instruction: plan.md, extra: true}', "unknown key 'extra'"],
    [
      'start: plan\nsteps:\n  plan:\n    instruction: plan.md\n    transitions: [{to: nowhere}]',
      'unknown target',
    ],
    [
      'start: plan\nsteps:\n  plan:\n    instruction: plan.md\n    outcome: {verdict: {type: enum, values: []}}',
      'outcome.verdict.values',
    ],
    [
      'start: plan\nsteps:\n  plan:\n    instruction: plan.md\n    transitions: [{when: {unknown: x}, to: plan}]',
      'unknown outcome field',
    ],
    [
      'start: plan\nsteps:\n  plan:\n    instruction: plan.md\n    transitions: [{to: plan}, {to: plan}]',
      'default transition must be last',
    ],
  ])('rejects invalid flows before creating state (%#)', (yaml, message) => {
    const cli = fixture();
    put(cli, '.stepan/flows/feature/flow.yaml', yaml);
    const result = runCli(['start', 'feature', 'TASK-1'], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain('\n    at ');
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });

  it.each(['absent', '../outside'])('refuses missing or outside flow: %s', (flow) => {
    const cli = fixture();
    const result = runCli(['start', flow, 'TASK-1'], cli);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(flow === 'absent' ? 'flow.yaml' : 'Invalid flow name');
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });

  it('preserves live and finished runs even when another start fails validation', () => {
    const cli = fixture();
    const first = runId(runCli(['start', 'feature', 'TASK-1'], cli));
    const path = runPath(cli, first);
    const before = readFileSync(path, 'utf8');
    const second = runId(runCli(['start', 'feature', 'TASK-1'], cli));
    expect(first).not.toBe(second);
    expect(readFileSync(path, 'utf8')).toBe(before);
    const finished = JSON.stringify({
      ...(JSON.parse(before) as Record<string, unknown>),
      finished: true,
    });
    writeFileSync(path, finished);
    put(cli, '.stepan/flows/bad/flow.yaml', 'invalid: true');
    expect(runCli(['start', 'bad', 'TASK-2'], cli).code).toBe(1);
    runId(runCli(['start', 'feature', 'TASK-2'], cli));
    expect(readFileSync(path, 'utf8')).toBe(finished);
    expect(readdirSync(cli.runsDirectory)).toHaveLength(3);
  });

  it.each(['installed', 'sources'] as const)(
    'starts concurrent processes without losing any %s run',
    async (layout) => {
      const cli = fixture(layout);
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          runCli(['start', 'feature', 'same task'], cli, { async: true }),
        ),
      );
      const ids = results.map(runId);
      expect(new Set(ids).size).toBe(4);
      expect(readdirSync(cli.runsDirectory).sort()).toEqual(ids.map((id) => `${id}.json`).sort());
      for (const id of ids)
        expect(JSON.parse(readFileSync(runPath(cli, id), 'utf8'))).toMatchObject({
          id,
          task: 'same task',
          flowName: 'feature',
        });
    },
  );

  it('reports filesystem failures without success output or a stack trace', () => {
    const cli = fixture();
    const definition = join(cli.cwd, '.stepan/flows/feature/flow.yaml');
    writeFileSync(cli.runsDirectory, 'not a directory');
    const result = runCli(['start', 'feature', 'TASK-1'], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain(cli.runsDirectory);
    expect(result.stderr).not.toContain('\n    at ');
    expect(readFileSync(cli.runsDirectory, 'utf8')).toBe('not a directory');
    expect(readFileSync(definition, 'utf8')).toBe(FLOW);
  });

  it.each([
    '      true: {type: number, required: true}\n      "true": {type: string}',
    '      1: {type: number}\n      "1": {type: string}',
    '      ? [a, b]\n      : {type: string}',
    '      &field value: {type: number}\n      ? *field\n      : {type: string}',
  ])('refuses coerced or overwritten YAML keys (%#)', (fields) => {
    const cli = fixture();
    put(
      cli,
      '.stepan/flows/feature/flow.yaml',
      `start: plan\nsteps:\n  plan:\n    instruction: plan.md\n    outcome:\n${fields}\n`,
    );
    const result = runCli(['start', 'feature', 'TASK-1'], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain('key');
    expect(result.stderr).toContain('flow.yaml');
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });
});
