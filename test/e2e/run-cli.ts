import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

export interface CliSandbox {
  sandbox: string;
  cwd: string;
  packageRoot: string;
  runPath: string;
}

/** Copy the executable and its runtime dependency so even source-mode writes stay isolated. */
export function createCli(layout: 'installed' | 'sources' = 'installed'): CliSandbox {
  const sandbox = mkdtempSync(join(tmpdir(), 'stepan-e2e-'));
  sandboxes.push(sandbox);
  const cwd = join(sandbox, 'проект с пробелами');
  const packageRoot = join(sandbox, 'package');
  mkdirSync(cwd);
  mkdirSync(packageRoot);
  cpSync(join(ROOT, 'dist'), join(packageRoot, 'dist'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(packageRoot, 'package.json'));
  cpSync(join(ROOT, 'node_modules/yaml'), join(packageRoot, 'node_modules/yaml'), {
    recursive: true,
  });
  if (layout === 'sources') {
    mkdirSync(join(packageRoot, 'src'));
    cpSync(join(ROOT, 'src/cli.ts'), join(packageRoot, 'src/cli.ts'));
    cpSync(join(ROOT, 'tsconfig.build.json'), join(packageRoot, 'tsconfig.build.json'));
  }
  const root = layout === 'sources' ? join(packageRoot, '.dev-data') : cwd;
  return { sandbox, cwd, packageRoot, runPath: join(root, '.stepan/run.json') };
}

/**
 * Runs an isolated copy of the built CLI. Reuse a sandbox to test successive invocations.
 * Home and config locations also point into it, never into the developer's real settings.
 */
export function runCli(args: string[], cli = createCli()): CliResult {
  const { sandbox, cwd, packageRoot } = cli;
  const result = spawnSync(process.execPath, [join(packageRoot, 'dist/cli.js'), ...args], {
    cwd,
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
