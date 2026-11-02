import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, runCli, type CliSandbox } from './run-cli.js';

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
  put(cli, 'flows/feature/flow.yaml', FLOW);
  put(cli, 'flows/feature/plan.md', 'Plan {{task}}.\n');
  put(cli, 'flows/feature/review.md', 'Review {{steps.plan.outcome.plan}}.\n');
  put(cli, 'flows/feature/finish.md', 'Finish.\n');
  return cli;
}

function readRun(cli: CliSandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(cli.runPath, 'utf8')) as Record<string, unknown>;
}

function writeRun(cli: CliSandbox, text: string): void {
  mkdirSync(dirname(cli.runPath), { recursive: true });
  writeFileSync(cli.runPath, text);
}

describe('stepan start', () => {
  it('snapshots the whole flow and prints the graph and initial exit template', () => {
    const cli = fixture();
    const result = runCli(['start', 'feature', 'STP-2: задача'], cli);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'plan -> review\nreview -> verdict="fail" -> plan, verdict="pass" -> finish\nfinish (final)\n\nPlan STP-2: задача.\n\nstepan next plan --plan "<text>" [--note "<text>"]\n',
    );
    expect(readRun(cli)).toEqual({
      version: 1,
      task: 'STP-2: задача',
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
    expect(readdirSync(dirname(cli.runPath))).toEqual(['run.json']);
    const before = readFileSync(cli.runPath, 'utf8');
    put(cli, 'flows/feature/flow.yaml', 'changed: true');
    put(cli, 'flows/feature/plan.md', 'Changed instruction.');
    expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
  });

  it.each(['installed', 'sources'] as const)(
    'writes only to the isolated %s root and reads flows from cwd',
    (layout) => {
      const cli = fixture(layout);
      expect(runCli(['start', 'feature', 'TASK-1'], cli).code).toBe(0);
      expect(existsSync(cli.runPath)).toBe(true);
      const other =
        layout === 'sources' ? join(cli.cwd, '.stepan') : join(cli.packageRoot, '.dev-data');
      expect(existsSync(other)).toBe(false);
      for (const path of ['.stepan', '.config', 'AppData', '.local']) {
        expect(existsSync(join(cli.sandbox, path))).toBe(false);
      }
    },
  );

  it('starts on a final step without outcomes and supports -- before positional values', () => {
    const cli = fixture();
    put(
      cli,
      'flows/-flow/flow.yaml',
      'start: done\nsteps:\n  done: {instruction: done.md, outcome: null, transitions: []}\n',
    );
    put(cli, 'flows/-flow/done.md', 'Done.');
    const result = runCli(['start', '--', '-flow', '-task'], cli);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('done (final)\n\nDone.\n\nstepan next done\n');
    expect(readRun(cli).task).toBe('-task');
  });

  it('prints enum and optional enum fields in the initial exit template', () => {
    const cli = fixture();
    put(
      cli,
      'flows/feature/flow.yaml',
      'start: review\nsteps:\n  review:\n    instruction: review.md\n    outcome:\n      verdict: {type: enum, values: [pass, fail], required: true}\n      note: {type: enum, values: [yes, no]}\n',
    );
    const result = runCli(['start', 'feature', 'TASK-1'], cli);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('stepan next review --verdict <pass|fail> [--note <yes|no>]');
  });

  it.each(
    [
      ['start'],
      ['start', 'feature'],
      ['start', 'feature', ''],
      ['start', 'feature', 'task', 'extra'],
      ['start', 'feature', 'task', '--unknown'],
      ['start', '--help', '--help'],
    ].map((args) => ({ args })),
  )('reports usage errors without writing state (%#)', ({ args }) => {
    const cli = fixture();
    const result = runCli(args, cli);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: stepan start');
    expect(existsSync(dirname(cli.runPath))).toBe(false);
  });

  it.each([[], ['--help'], ['start', '--help'], ['start', '-h']].map((args) => ({ args })))(
    'documents start in help (%#)',
    ({ args }) => {
      const result = runCli(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('start <flow> <task>');
      expect(result.stderr).toBe('');
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
  ])('rejects invalid flows before creating state or lock (%#)', (yaml, message) => {
    const cli = fixture();
    put(cli, 'flows/feature/flow.yaml', yaml);
    const result = runCli(['start', 'feature', 'TASK-1'], cli);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain('at start (');
    expect(existsSync(dirname(cli.runPath))).toBe(false);
  });

  it.each(['absent', '../outside'])('refuses missing or outside flow: %s', (flow) => {
    const cli = fixture();
    const result = runCli(['start', flow, 'TASK-1'], cli);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(flow === 'absent' ? 'flow.yaml' : 'Invalid flow name');
    expect(existsSync(dirname(cli.runPath))).toBe(false);
  });

  it('does not overwrite a live run on a second start', () => {
    const cli = fixture();
    expect(runCli(['start', 'feature', 'TASK-1'], cli).code).toBe(0);
    const before = readFileSync(cli.runPath, 'utf8');
    const result = runCli(['start', 'feature', 'TASK-2'], cli);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('already live');
    expect(result.stdout).toBe('');
    expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
  });

  it.each(['{broken', '{"version":99}', '{"version":1,"finished":true}'])(
    'does not overwrite a damaged or unknown-version run (%#)',
    (text) => {
      const cli = fixture();
      writeRun(cli, text);
      const result = runCli(['start', 'feature', 'TASK-2'], cli);
      expect(result.code).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stdout).toBe('');
      expect(readFileSync(cli.runPath, 'utf8')).toBe(text);
      expect(existsSync(join(dirname(cli.runPath), 'start.lock'))).toBe(false);
    },
  );

  it('replaces a finished run only when the new flow is valid', () => {
    const cli = fixture();
    expect(runCli(['start', 'feature', 'TASK-1'], cli).code).toBe(0);
    writeRun(cli, JSON.stringify({ ...readRun(cli), finished: true }));
    const before = readFileSync(cli.runPath, 'utf8');
    put(cli, 'flows/bad/flow.yaml', 'invalid: true');
    expect(runCli(['start', 'bad', 'TASK-2'], cli).code).toBe(1);
    expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
    expect(runCli(['start', 'feature', 'TASK-2'], cli).code).toBe(0);
    expect(readRun(cli)).toMatchObject({
      task: 'TASK-2',
      step: 'plan',
      finished: false,
      outcomes: {},
    });
  });

  it.each([false, true])(
    'refuses a busy start lock without changing state (existing finished run=%s)',
    (finished) => {
      const cli = fixture();
      if (finished) {
        expect(runCli(['start', 'feature', 'TASK-1'], cli).code).toBe(0);
        writeRun(cli, JSON.stringify({ ...readRun(cli), finished: true }));
      } else {
        mkdirSync(dirname(cli.runPath), { recursive: true });
      }
      const before = finished ? readFileSync(cli.runPath, 'utf8') : undefined;
      const lock = join(dirname(cli.runPath), 'start.lock');
      writeFileSync(lock, 'busy');
      const result = runCli(['start', 'feature', 'TASK-2'], cli);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Another command');
      expect(result.stderr).toContain(lock);
      expect(readFileSync(lock, 'utf8')).toBe('busy');
      if (before === undefined) expect(existsSync(cli.runPath)).toBe(false);
      else expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
    },
  );

  it('reports filesystem write failures without a success message or stack trace', () => {
    const cli = fixture();
    writeFileSync(join(cli.cwd, '.stepan'), 'not a directory');
    const result = runCli(['start', 'feature', 'TASK-1'], cli);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('.stepan');
    expect(result.stderr).not.toContain('at start (');
  });

  it('refuses an unreadable run path without replacing it', () => {
    const cli = fixture();
    mkdirSync(cli.runPath, { recursive: true });
    const result = runCli(['start', 'feature', 'TASK-2'], cli);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('run.json');
    expect(readdirSync(cli.runPath)).toEqual([]);
  });

  it.each([
    '      true: {type: number, required: true}\n      "true": {type: string}',
    '      1: {type: number}\n      "1": {type: string}',
    '      ? [a, b]\n      : {type: string}',
    '      &field value: {type: number}\n      ? *field\n      : {type: string}',
  ])('refuses mappings whose keys would be coerced or overwritten (%#)', (fields) => {
    const cli = fixture();
    put(
      cli,
      'flows/feature/flow.yaml',
      `start: plan\nsteps:\n  plan:\n    instruction: plan.md\n    outcome:\n${fields}\n`,
    );
    const result = runCli(['start', 'feature', 'TASK-1'], cli);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('key');
    expect(result.stderr).toContain('flow.yaml');
    expect(existsSync(dirname(cli.runPath))).toBe(false);
  });
});
