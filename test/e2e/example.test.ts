import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCli, runCli, runId } from './run-cli.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLE = join(ROOT, '.stepan/flows/example');

function markdownBesideFlow(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.md'));
}

describe('repository example', () => {
  it('keeps flow.yaml at the example root and instructions in steps/', () => {
    expect(readdirSync(EXAMPLE)).toContain('flow.yaml');
    expect(readdirSync(join(EXAMPLE, 'steps'))).toEqual(
      expect.arrayContaining(['implement.md', 'review.md', 'finish.md']),
    );
    expect(markdownBesideFlow(EXAMPLE)).toEqual([]);
  });

  it.each(['installed', 'sources'] as const)(
    'walks the shipped example through review rework and completion in %s mode',
    (layout) => {
      const cli = createCli(layout);
      const directory = join(cli.cwd, '.stepan/flows/example');
      const steps = join(directory, 'steps');
      mkdirSync(steps, { recursive: true });
      // Node 22's native recursive cpSync corrupts non-ASCII destination paths on Windows.
      copyFileSync(join(EXAMPLE, 'flow.yaml'), join(directory, 'flow.yaml'));
      for (const file of readdirSync(join(EXAMPLE, 'steps'))) {
        copyFileSync(join(EXAMPLE, 'steps', file), join(steps, file));
      }
      expect(readdirSync(directory)).toContain('flow.yaml');
      expect(markdownBesideFlow(directory)).toEqual([]);

      const started = runCli(['start', 'example', 'TASK-12'], cli);
      const id = runId(started);
      expect(started.stderr).toBe('');
      expect(started.stdout).toContain('implement -> review');
      expect(started.stdout).toContain(
        'review -> verdict="fail" -> implement, verdict="pass" -> finish',
      );
      expect(started.stdout).toContain('finish (final)');
      expect(started.stdout).toContain('Complete TASK-12');

      const review = runCli(['next', id, '--summary', 'First implementation.'], cli);
      expect(review).toMatchObject({ code: 0, stderr: '' });
      expect(review.stdout).toContain('Step: review');
      expect(review.stdout).toContain('First implementation.');
      expect(review.stdout).not.toContain('{{steps.implement.outcome.summary}}');

      const rework = runCli(
        ['next', id, '--verdict=fail', '--findings', 'Add a regression test.'],
        cli,
      );
      expect(rework).toMatchObject({ code: 0, stderr: '' });
      expect(rework.stdout).toContain('Step: implement');
      expect(rework.stdout).toContain('Previous review findings: Add a regression test.');
      expect(runCli(['current', id], cli)).toMatchObject({
        code: 0,
        stdout: rework.stdout,
        stderr: '',
      });

      const reviewedAgain = runCli(
        ['next', id, '--summary', 'Implementation with a regression test.'],
        cli,
      );
      expect(reviewedAgain).toMatchObject({ code: 0, stderr: '' });
      expect(reviewedAgain.stdout).toContain('Implementation with a regression test.');
      expect(reviewedAgain.stdout).not.toContain('First implementation.');

      const final = runCli(['next', id, '--verdict=pass'], cli);
      expect(final).toMatchObject({ code: 0, stderr: '' });
      expect(final.stdout).toContain('Step: finish');
      expect(final.stdout).toContain('Implementation with a regression test.');
      expect(final.stdout).toContain('Review verdict: pass');
      expect(final.stdout).toContain(`stepan next ${id}\n`);
      expect(runCli(['next', id], cli)).toMatchObject({
        code: 0,
        stdout: `Run ${id} is finished.\n`,
        stderr: '',
      });
      expect(runCli(['current', id], cli).stdout).toBe(`Run ${id} is finished.\n`);
      expect(runCli(['runs'], cli).stdout).toBe('No active runs.\n');
      expect(runCli(['runs', '--all'], cli).stdout).toContain(id);
    },
  );
});
