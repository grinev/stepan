import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runView, type RunState } from '../../src/run.js';
import { createCli, runCli, runPath, startCli, type RunningCli } from './run-cli.js';

const ID = 'a7c93f2b';
const FLOW = `start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      plan: {type: string, required: true}
      note: {type: string}
      reason: {type: enum, values: [small, large]}
    transitions:
      - to: review
  review:
    instruction: review.md
    outcome:
      verdict: {type: enum, values: [pass, fail, hold], required: true}
      findings: {type: string}
    transitions:
      - when: {verdict: fail}
        to: plan
      - when: {verdict: pass}
        to: finish
  finish:
    instruction: finish.md
`;
const PLAN =
  'Run: RUN-ID\nStep: plan\n\nInstructions:\nPlan STP-8: задача.\n\nAfter completing this step, run:\nstepan next RUN-ID --plan "<text>" [--note "<text>"] [--reason <small|large>]\n';
function reviewOutput(plan: string): string {
  return `Run: RUN-ID\nStep: review\n\nInstructions:\nReview ${plan}.\n\nAfter completing this step, run:\nstepan next RUN-ID --verdict <pass|fail|hold> [--findings "<text>"]\n`;
}
const FINISH =
  'Run: RUN-ID\nStep: finish\n\nInstructions:\nFinish.\n\nAfter completing this step, run:\nstepan next RUN-ID\n';
const FINISHED = 'Run RUN-ID is finished.\n';

function fixture(layout: 'installed' | 'sources' = 'installed', flow = FLOW): RunningCli {
  const cli = createCli(layout);
  const directory = join(cli.cwd, '.stepan/flows/feature');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'flow.yaml'), flow);
  writeFileSync(join(directory, 'plan.md'), 'Plan {{task}}.\n');
  writeFileSync(join(directory, 'review.md'), 'Review {{steps.plan.outcome.plan}}.\n');
  writeFileSync(join(directory, 'finish.md'), 'Finish.');
  return startCli(cli, 'STP-8: задача');
}
function readRun(cli: RunningCli): RunState {
  return JSON.parse(readFileSync(cli.runPath, 'utf8')) as RunState;
}
function success(cli: RunningCli, args: string[], stdout: string): void {
  const before = readRun(cli);
  const result = runCli(args, cli);
  expect(result).toMatchObject({ code: 0, stderr: '' });
  expect(result.stdout.replaceAll(cli.id, 'RUN-ID')).toBe(stdout);
  expect(readdirSync(cli.runsDirectory)).toEqual([`${cli.id}.json`]);
  const after = readRun(cli);
  expect(Object.keys(after).sort()).toEqual(['events', 'flowName', 'id', 'task', 'version']);
  if (args[0] === 'next') {
    expect(after.events.slice(0, -1)).toEqual(before.events);
    expect(after.events).toHaveLength(before.events.length + 1);
  } else expect(after).toEqual(before);
  for (const event of after.events) {
    expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(event.at).toISOString()).toBe(event.at);
  }
}
function refusal(cli: RunningCli, args: string[], code: number, message: string): void {
  const before = readFileSync(cli.runPath, 'utf8');
  const result = runCli(args, cli);
  expect(result).toMatchObject({ code, stdout: '' });
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain('\n    at ');
  expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
  expect(existsSync(join(cli.runsDirectory, `${cli.id}.lock`))).toBe(false);
}

describe('stepan next', () => {
  it.each(['installed', 'sources'] as const)(
    'walks a full loop and finishes in the isolated %s layout',
    (layout) => {
      const cli = fixture(layout);
      success(cli, ['current', cli.id], PLAN);
      success(
        cli,
        ['next', cli.id, '--plan', 'первый план', '--note', 'remove', '--reason', 'small'],
        reviewOutput('первый план'),
      );
      expect(runView(readRun(cli))).toMatchObject({
        step: 'review',
        finished: false,
        outcomes: { plan: { plan: 'первый план', note: 'remove', reason: 'small' } },
      });
      success(cli, ['current', cli.id], reviewOutput('первый план'));
      success(cli, ['next', cli.id, '--verdict=fail', '--findings=revise'], PLAN);
      success(cli, ['next', cli.id, '--plan=новый план'], reviewOutput('новый план'));
      expect(runView(readRun(cli)).outcomes).toEqual({
        plan: { plan: 'новый план' },
        review: { verdict: 'fail', findings: 'revise' },
      });
      success(cli, ['next', cli.id, '--verdict=pass'], FINISH);
      expect(runView(readRun(cli))).toMatchObject({ step: 'finish', finished: false });
      success(cli, ['current', cli.id], FINISH);
      success(cli, ['next', cli.id], FINISHED);
      const completed = readRun(cli);
      expect({
        ...completed,
        events: completed.events.map(({ at, ...event }) => {
          expect(new Date(at).toISOString()).toBe(at);
          return event;
        }),
      }).toEqual({
        version: 2,
        id: cli.id,
        flowName: 'feature',
        task: 'STP-8: задача',
        events: [
          { type: 'started', step: 'plan' },
          {
            type: 'transitioned',
            from: 'plan',
            to: 'review',
            outcome: { plan: 'первый план', note: 'remove', reason: 'small' },
          },
          {
            type: 'transitioned',
            from: 'review',
            to: 'plan',
            outcome: { verdict: 'fail', findings: 'revise' },
          },
          {
            type: 'transitioned',
            from: 'plan',
            to: 'review',
            outcome: { plan: 'новый план' },
          },
          {
            type: 'transitioned',
            from: 'review',
            to: 'finish',
            outcome: { verdict: 'pass' },
          },
          { type: 'finished', step: 'finish', outcome: {} },
        ],
      });
      rmSync(join(cli.cwd, '.stepan/flows'), { recursive: true });
      expect(runCli(['runs', '--all'], cli)).toMatchObject({ code: 0, stderr: '' });
      success(cli, ['current', cli.id], FINISHED);
      refusal(cli, ['next', cli.id], 1, 'is finished.');
      refusal(cli, ['next', cli.id, '--unknown'], 1, 'is finished.');
      const other =
        layout === 'sources' ? join(cli.cwd, '.stepan/runs') : join(cli.packageRoot, '.dev-data');
      expect(existsSync(other)).toBe(false);
      for (const path of ['.stepan', '.config', 'AppData', '.local'])
        expect(existsSync(join(cli.sandbox, path))).toBe(false);
    },
  );

  it.each([
    { args: ['plan', '--plan=value'], code: 2, message: 'argument' },
    { args: [], code: 1, message: 'plan: required' },
    { args: ['--plan='], code: 1, message: 'plan: required' },
    { args: ['--plan=value', '--reason=other'], code: 1, message: 'reason: invalid enum' },
    { args: ['--plan=value', '--unknown=x'], code: 2, message: 'unknown' },
    { args: ['--plan=value', '--plan=again'], code: 2, message: 'Repeated option' },
    { args: ['--plan'], code: 2, message: 'argument' },
    { args: ['--plan=value', 'extra'], code: 2, message: 'argument' },
    { args: ['-p', 'value'], code: 2, message: 'option' },
    { args: ['--help'], code: 2, message: 'option' },
  ])(
    'refuses invalid outcome or an extra step without changing state (%#)',
    ({ args, code, message }) => {
      const cli = fixture();
      refusal(cli, ['next', cli.id, ...args], code, message);
      expect(runView(readRun(cli)).outcomes).toEqual({});
      success(cli, ['current', cli.id], PLAN);
    },
  );

  it.each([
    { args: [], message: 'verdict: required' },
    { args: ['--verdict='], message: 'verdict: required' },
    { args: ['--verdict=other'], message: 'verdict: invalid enum' },
    { args: ['--verdict=hold'], message: 'no matching transition' },
  ])('refuses invalid enum or unmatched transition (%#)', ({ args, message }) => {
    const cli = fixture();
    success(cli, ['next', cli.id, '--plan=value'], reviewOutput('value'));
    refusal(cli, ['next', cli.id, ...args], 1, message);
    expect(runView(readRun(cli)).outcomes).toEqual({ plan: { plan: 'value' } });
    success(cli, ['current', cli.id], reviewOutput('value'));
  });

  it.each(['installed', 'sources'] as const)(
    'uses edited instructions, schemas and transitions in %s',
    (layout) => {
      const cli = fixture(layout);
      const directory = join(cli.cwd, '.stepan/flows/feature');
      const before = readRun(cli);
      writeFileSync(
        join(directory, 'flow.yaml'),
        FLOW.replace(
          'plan: {type: string, required: true}',
          'updated: {type: string, required: true}',
        ).replace('to: review', 'to: finish'),
      );
      writeFileSync(join(directory, 'finish.md'), 'Changed {{steps.plan.outcome.updated}}.');
      refusal(cli, ['next', cli.id, '--plan=old schema'], 2, 'plan');
      success(
        cli,
        ['next', cli.id, '--updated=new value'],
        'Run: RUN-ID\nStep: finish\n\nInstructions:\nChanged new value.\n\nAfter completing this step, run:\nstepan next RUN-ID\n',
      );
      expect(readRun(cli).events[0]).toEqual(before.events[0]);
      expect(readRun(cli).events[1]).toMatchObject({
        from: 'plan',
        to: 'finish',
        outcome: { updated: 'new value' },
      });
    },
  );

  it.each(['installed', 'sources'] as const)(
    'does not replay history against edited %s definitions',
    (layout) => {
      const cli = fixture(layout);
      success(cli, ['next', cli.id, '--plan=historical'], reviewOutput('historical'));
      const before = readRun(cli);
      const directory = join(cli.cwd, '.stepan/flows/feature');
      writeFileSync(
        join(directory, 'flow.yaml'),
        'start: finish\nsteps:\n  plan:\n    instruction: plan.md\n    outcome:\n      plan: {type: enum, values: [new], required: true}\n  review:\n    instruction: review.md\n  finish:\n    instruction: finish.md\n',
      );
      success(
        cli,
        ['current', cli.id],
        'Run: RUN-ID\nStep: review\n\nInstructions:\nReview historical.\n\nAfter completing this step, run:\nstepan next RUN-ID\n',
      );
      writeFileSync(
        join(directory, 'flow.yaml'),
        'start: finish\nsteps:\n  review:\n    instruction: review.md\n  finish:\n    instruction: finish.md\n',
      );
      success(
        cli,
        ['current', cli.id],
        'Run: RUN-ID\nStep: review\n\nInstructions:\nReview historical.\n\nAfter completing this step, run:\nstepan next RUN-ID\n',
      );
      success(cli, ['next', cli.id], FINISHED);
      expect(readRun(cli).events.slice(0, -1)).toEqual(before.events);
    },
  );

  it.each(['installed', 'sources'] as const)(
    'refuses incompatible %s flow edits without advancing',
    (layout) => {
      const cli = fixture(layout);
      const directory = join(cli.cwd, '.stepan/flows/feature');
      for (const yaml of [
        'start: finish\nsteps:\n  finish: {instruction: finish.md}\n',
        'start: [',
        FLOW.replace('review.md', 'missing.md'),
      ]) {
        writeFileSync(join(directory, 'flow.yaml'), yaml);
        for (const args of [
          ['current', cli.id],
          ['next', cli.id, '--plan=value'],
        ]) {
          refusal(cli, args, 1, `Run ${cli.id}, flow 'feature'`);
        }
      }
      rmSync(directory, { recursive: true });
      refusal(cli, ['next', cli.id, '--plan=value'], 1, 'flow.yaml');
      expect(runCli(['runs'], cli)).toMatchObject({ code: 0, stderr: '' });
    },
  );

  it('tries a conditional before the default and replaces optional fields', () => {
    const cli = fixture(
      'installed',
      `start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      note: {type: string}
    transitions:
      - when: {note: ''}
        to: plan
      - to: finish
  finish:
    instruction: finish.md
`,
    );
    success(
      cli,
      ['next', cli.id, '--note='],
      'Run: RUN-ID\nStep: plan\n\nInstructions:\nPlan STP-8: задача.\n\nAfter completing this step, run:\nstepan next RUN-ID [--note "<text>"]\n',
    );
    expect(runView(readRun(cli)).outcomes.plan).toEqual({ note: '' });
    success(cli, ['next', cli.id], FINISH);
    expect(runView(readRun(cli)).outcomes.plan).toEqual({});
    expect(readRun(cli).events[1]).toMatchObject({
      type: 'transitioned',
      from: 'plan',
      to: 'plan',
      outcome: { note: '' },
    });
  });

  it('requires the final outcome before marking the run finished', () => {
    const cli = fixture(
      'installed',
      'start: finish\nsteps:\n  finish:\n    instruction: finish.md\n    outcome:\n      summary: {type: string, required: true}\n',
    );
    refusal(cli, ['next', cli.id], 1, 'summary: required');
    expect(runView(readRun(cli)).finished).toBe(false);
    success(cli, ['next', cli.id, '--summary=Done.'], FINISHED);
    expect(runView(readRun(cli)).outcomes.finish).toEqual({ summary: 'Done.' });
  });

  it('accepts help, h, version and prototype names and preserves exact strings', () => {
    const cli = fixture(
      'installed',
      `start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      help: {type: string, required: true}
      h: {type: string}
      version: {type: string}
      constructor: {type: string}
      toString: {type: string}
      x: {type: string}
`,
    );
    refusal(cli, ['next', cli.id, '-x', 'value'], 2, 'flag');
    refusal(cli, ['next', cli.id, '--help'], 2, 'argument');
    success(
      cli,
      [
        'next',
        cli.id,
        '--help',
        '  ',
        '--h=',
        '--version=0',
        '--constructor=-text',
        '--toString',
        'текст с пробелами',
      ],
      FINISHED,
    );
    expect(runView(readRun(cli)).outcomes.plan).toEqual({
      help: '  ',
      h: '',
      version: '0',
      constructor: '-text',
      toString: 'текст с пробелами',
    });
  });

  it.each(['--help', '-h'])('prints standalone %s without state', (flag) => {
    const cli = createCli();
    const result = runCli(['next', flag], cli);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('Usage: stepan next <run-id>');
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });

  it.each([
    [],
    [''],
    ['plan'],
    ['../outside'],
    ['A7C93F2B'],
    ['--verdict', 'pass'],
    ['--help', 'extra'],
    ['-h', '--help'],
  ])('rejects missing or invalid IDs without creating state (%#)', (...args) => {
    const cli = createCli();
    const result = runCli(['next', ...args], cli);
    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toContain('Usage: stepan next');
    expect(existsSync(cli.runsDirectory)).toBe(false);
  });

  it.each(['installed', 'sources'] as const)(
    'reports missing state without creating the %s directory',
    (layout) => {
      const cli = createCli(layout);
      const result = runCli(['next', ID, '--plan=value'], cli);
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain('No run found');
      expect(existsSync(cli.runsDirectory)).toBe(false);
    },
  );

  it.each(['{invalid', '{"version":99}', '{"version":1,"finished":true}'])(
    'preserves unreadable or unknown-version state (%#)',
    (text) => {
      const cli = fixture();
      writeFileSync(cli.runPath, text);
      refusal(cli, ['next', cli.id, '--plan=value'], 1, cli.runPath);
    },
  );

  it('preserves an unreadable run path', () => {
    const cli = createCli();
    const path = runPath(cli, ID);
    mkdirSync(path, { recursive: true });
    const result = runCli(['next', ID], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain(path);
    expect(readdirSync(path)).toEqual([]);
    expect(readdirSync(cli.runsDirectory)).toEqual([`${ID}.json`]);
  });

  it('refuses a busy per-run lock without modifying it', () => {
    const cli = fixture();
    const before = readFileSync(cli.runPath, 'utf8');
    const lock = join(cli.runsDirectory, `${cli.id}.lock`);
    writeFileSync(lock, 'busy');
    const result = runCli(['next', cli.id, '--plan=value'], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain('Another command');
    expect(result.stderr).toContain(lock);
    expect(readFileSync(cli.runPath, 'utf8')).toBe(before);
    expect(readFileSync(lock, 'utf8')).toBe('busy');
  });
});
