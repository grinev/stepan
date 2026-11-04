import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCli, runCli, runId, runPath, startCli, type CliSandbox } from './run-cli.js';

const ID = 'a7c93f2b';
function fixture(layout: 'installed' | 'sources' = 'installed'): CliSandbox {
  const cli = createCli(layout);
  const directory = join(cli.cwd, '.stepan/flows/feature');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'flow.yaml'),
    `start: plan
steps:
  plan:
    instruction: plan.md
    outcome:
      text: {type: string}
    transitions:
      - to: finish
  finish:
    instruction: finish.md
`,
  );
  writeFileSync(join(directory, 'plan.md'), 'Plan {{task}}.');
  writeFileSync(join(directory, 'finish.md'), 'Finish {{steps.plan.outcome.text}}.');
  return cli;
}

describe('independent runs', () => {
  it('advertises rm and rejects the old abort command without deleting a run', () => {
    const cli = fixture();
    const run = startCli(cli, 'task');
    const original = readFileSync(run.runPath, 'utf8');
    const help = runCli(['--help'], cli);
    expect(help).toMatchObject({ code: 0, stderr: '' });
    expect(help.stdout).toContain('rm <run-id>');
    expect(help.stdout).not.toContain('abort');
    const rejected = runCli(['abort', run.id], cli);
    expect(rejected).toMatchObject({ code: 2, stdout: '' });
    expect(rejected.stderr).toContain("unknown command 'abort'");
    expect(readFileSync(run.runPath, 'utf8')).toBe(original);
  });

  it.each(['installed', 'sources'] as const)(
    'advances, lists and deletes selected %s runs only',
    (layout) => {
      const cli = fixture(layout);
      const first = startCli(cli, 'same task');
      const second = startCli(cli, 'same task');
      const untouched = readFileSync(second.runPath, 'utf8');
      const active = runCli(['runs'], cli);
      expect(active).toMatchObject({ code: 0, stderr: '' });
      expect(active.stdout).toContain('ID\tFLOW\tTASK\tSTEP\tSTATUS\n');
      expect(active.stdout).toContain(`"${first.id}"\t"feature"\t"same task"\t"plan"\t"active"`);
      expect(active.stdout).toContain(second.id);
      expect(active.stdout.split('\n').slice(1, -1)).toEqual(
        active.stdout.split('\n').slice(1, -1).sort(),
      );

      expect(runCli(['next', first.id, '--text=one'], cli).stdout).toContain(
        `stepan next ${first.id}\n`,
      );
      expect(readFileSync(second.runPath, 'utf8')).toBe(untouched);
      expect(runCli(['current', first.id], cli).stdout).toContain('Finish one.');
      expect(runCli(['current', second.id], cli).stdout).toContain('Plan same task.');
      expect(runCli(['next', first.id], cli)).toMatchObject({
        code: 0,
        stdout: `Run ${first.id} is finished.\n`,
      });
      const finishedBytes = readFileSync(first.runPath, 'utf8');
      const third = startCli(cli, 'different task');
      expect(readFileSync(first.runPath, 'utf8')).toBe(finishedBytes);
      expect(readFileSync(second.runPath, 'utf8')).toBe(untouched);
      expect(runCli(['runs'], cli).stdout).not.toContain(first.id);
      const all = runCli(['runs', '--all'], cli);
      expect(all.stdout).toContain(`"${first.id}"\t"feature"\t"same task"\t"finish"\t"finished"`);
      expect(all.stdout).toContain(second.id);
      expect(all.stdout).toContain(third.id);

      expect(runCli(['rm', first.id], cli)).toMatchObject({
        code: 0,
        stdout: `Run ${first.id} deleted.\n`,
        stderr: '',
      });
      expect(existsSync(first.runPath)).toBe(false);
      expect(runCli(['runs', '--all'], cli).stdout).not.toContain(first.id);
      expect(runCli(['current', first.id], cli)).toMatchObject({ code: 1, stdout: '' });
      expect(readFileSync(second.runPath, 'utf8')).toBe(untouched);
      expect(runCli(['rm', third.id], cli).code).toBe(0);
      expect(runCli(['rm', second.id], cli).code).toBe(0);
      expect(runCli(['runs'], cli)).toMatchObject({ code: 0, stdout: 'No active runs.\n' });
      expect(runCli(['runs', '--all'], cli)).toMatchObject({ code: 0, stdout: 'No runs.\n' });
      expect(readdirSync(cli.runsDirectory)).toEqual([]);
      expect(runCli(['rm', first.id], cli).code).toBe(1);
    },
  );

  it('a held lock does not prevent advancing, removing or starting another run', () => {
    const cli = fixture();
    const first = startCli(cli, 'one');
    const second = startCli(cli, 'two');
    const before = readFileSync(first.runPath, 'utf8');
    const lock = join(cli.runsDirectory, `${first.id}.lock`);
    writeFileSync(lock, 'busy');
    for (const command of ['next', 'rm']) {
      const result = runCli([command, first.id], cli);
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain(lock);
    }
    expect(runCli(['current', first.id], cli).code).toBe(0);
    expect(runCli(['runs'], cli).code).toBe(0);
    expect(runCli(['next', second.id], cli).code).toBe(0);
    expect(runCli(['rm', second.id], cli).code).toBe(0);
    expect(runId(runCli(['start', 'feature', 'three'], cli))).toMatch(/^[0-9a-f]{8}$/);
    expect(readFileSync(first.runPath, 'utf8')).toBe(before);
    expect(readFileSync(lock, 'utf8')).toBe('busy');
  });

  it('escapes multiline task values so each run occupies one table row', () => {
    const cli = fixture();
    const task = 'one\ntwo\t"three"';
    const run = startCli(cli, task);
    const result = runCli(['runs'], cli);
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n')).toHaveLength(3);
    expect(result.stdout).toContain(JSON.stringify(task));
    expect(result.stdout).toContain(run.id);
  });
});

describe('rm and listing errors', () => {
  it.each(['installed', 'sources'] as const)(
    'reports invalid %s run filenames without changing existing state',
    (layout) => {
      const cli = fixture(layout);
      const run = startCli(cli, 'keep');
      const before = readFileSync(run.runPath, 'utf8');
      const invalid = join(cli.runsDirectory, 'invalid.json');
      writeFileSync(invalid, 'keep invalid file');
      for (const args of [['runs'], ['runs', '--all']]) {
        const result = runCli(args, cli);
        expect(result).toMatchObject({ code: 1, stdout: '' });
        expect(result.stderr).toContain(`${invalid}: invalid run filename`);
        expect(result.stderr).not.toContain('\n    at ');
        expect(readFileSync(invalid, 'utf8')).toBe('keep invalid file');
        expect(readFileSync(run.runPath, 'utf8')).toBe(before);
      }
    },
  );

  it.each(['installed', 'sources'] as const)(
    'reports a blocked %s runs directory without treating it as an empty list',
    (layout) => {
      const cli = createCli(layout);
      mkdirSync(join(cli.root, '.stepan'), { recursive: true });
      writeFileSync(cli.runsDirectory, 'keep blocking file');
      for (const args of [['runs'], ['runs', '--all']]) {
        const result = runCli(args, cli);
        expect(result).toMatchObject({ code: 1, stdout: '' });
        expect(result.stderr).toContain(cli.runsDirectory);
        expect(result.stderr).not.toContain('\n    at ');
        expect(readFileSync(cli.runsDirectory, 'utf8')).toBe('keep blocking file');
      }
    },
  );

  it.each(['{broken', '{"version":99}', '{"version":1}'])(
    'reports damaged runs in the list and lets rm remove them (%#)',
    (text) => {
      const cli = fixture();
      const run = startCli(cli, 'damaged');
      writeFileSync(run.runPath, text);
      for (const args of [['runs'], ['runs', '--all']]) {
        const result = runCli(args, cli);
        expect(result).toMatchObject({ code: 1, stdout: '' });
        expect(result.stderr).toContain(run.runPath);
        expect(readFileSync(run.runPath, 'utf8')).toBe(text);
      }
      const other = startCli(cli, 'new run beside damaged state');
      expect(readFileSync(run.runPath, 'utf8')).toBe(text);
      expect(runCli(['rm', other.id], cli).code).toBe(0);
      expect(runCli(['rm', run.id], cli)).toMatchObject({
        code: 0,
        stdout: `Run ${run.id} deleted.\n`,
      });
      expect(existsSync(run.runPath)).toBe(false);
      expect(runCli(['runs'], cli).stdout).toBe('No active runs.\n');
    },
  );

  it.each(['installed', 'sources'] as const)(
    'does not create missing %s state for reads or rm',
    (layout) => {
      const cli = createCli(layout);
      expect(runCli(['rm', ID], cli)).toMatchObject({ code: 1, stdout: '' });
      expect(runCli(['runs'], cli)).toMatchObject({ code: 0, stdout: 'No active runs.\n' });
      expect(runCli(['runs', '--all'], cli)).toMatchObject({ code: 0, stdout: 'No runs.\n' });
      expect(existsSync(join(cli.root, '.stepan'))).toBe(false);
    },
  );

  it.each([
    ['rm'],
    ['rm', 'ABCDEF12'],
    ['rm', '../outside'],
    ['rm', ID, 'extra'],
    ['rm', '--help', ID],
    ['rm', ID, '--unknown'],
    ['rm', '--help', '-h'],
    ['runs', 'extra'],
    ['runs', '--all', '--all'],
    ['runs', '--unknown'],
    ['runs', '--all=true'],
    ['runs', '--help', '--all'],
    ['runs', '-hh'],
  ])('rejects usage errors without creating state (%#)', (...args) => {
    const cli = createCli();
    expect(runCli(args, cli)).toMatchObject({ code: 2, stdout: '' });
    expect(existsSync(join(cli.root, '.stepan'))).toBe(false);
  });

  it('does not recursively delete an unreadable run directory', () => {
    const cli = createCli();
    const path = runPath(cli, ID);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'keep'), 'keep');
    expect(runCli(['rm', ID], cli)).toMatchObject({ code: 1, stdout: '' });
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('keep');
    expect(readdirSync(cli.runsDirectory)).toEqual([`${ID}.json`]);
  });
});
