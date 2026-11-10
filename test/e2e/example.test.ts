import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCli, runCli, runId } from './run-cli.js';
import { commitFixture, exampleFixture, gitRepository } from './git-fixture.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLE = join(ROOT, 'test/fixtures/example');

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
    'installs the example and walks review rework and completion offline in %s mode',
    (layout) => {
      const cli = createCli(layout);
      const { repo, url } = gitRepository(cli);
      exampleFixture(repo);
      commitFixture(cli, repo);
      expect(runCli(['install', url, '--flow', 'example'], cli)).toMatchObject({
        code: 0,
        stderr: '',
      });
      rmSync(repo, { recursive: true, force: true });
      cli.cwd = cli.root;
      const directory = join(cli.cwd, '.stepan/flows/example');
      expect(readdirSync(directory)).toContain('flow.yaml');
      expect(markdownBesideFlow(directory)).toEqual([]);

      const started = runCli(['start', 'example', 'TASK-12'], cli);
      const id = runId(started);
      expect(started.stderr).toBe('');
      expect(started.stdout).toMatch(/^Flow description:\n/);
      expect(started.stdout).toContain('Instructions:\n# Implement');
      expect(started.stdout).toContain(
        'Implement a task, review it, and address findings until the work is ready to finish.',
      );
      expect(started.stdout).not.toContain(' -> ');
      expect(started.stdout).toContain('Complete TASK-12');
      expect(started.stdout).toContain('Previous review findings: -');

      const review = runCli(['next', id, '--summary', 'First implementation.'], cli);
      expect(review).toMatchObject({ code: 0, stderr: '' });
      expect(review.stdout).toContain('Step: review');
      expect(review.stdout).toContain('Instructions:\n# Review');
      expect(review.stdout).not.toContain('Flow description:');
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
      expect(final.stdout).toContain(`After completing this step, run:\nstepan next ${id}\n`);
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
