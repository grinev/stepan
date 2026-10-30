import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Throwaway directory the CLI ran in; also its home and config root. */
  sandbox: string;
}

/**
 * Runs the built CLI in a fresh temporary directory. Home and config locations point into the
 * same directory, so nothing the CLI writes can reach the developer's real settings.
 */
export function runCli(args: string[]): CliResult {
  const sandbox = mkdtempSync(join(tmpdir(), 'stepan-e2e-'));
  sandboxes.push(sandbox);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: sandbox,
      USERPROFILE: sandbox,
      APPDATA: join(sandbox, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(sandbox, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(sandbox, '.config'),
      XDG_DATA_HOME: join(sandbox, '.local', 'share'),
      XDG_STATE_HOME: join(sandbox, '.local', 'state'),
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, sandbox };
}
