import { spawn, spawnSync } from 'node:child_process';
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
  root: string;
  runsDirectory: string;
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
  return { sandbox, cwd, packageRoot, root, runsDirectory: join(root, '.stepan/runs') };
}

export function runPath(cli: CliSandbox, id: string): string {
  return join(cli.runsDirectory, `${id}.json`);
}

export function runId(result: CliResult): string {
  const id = /^Run: ([0-9a-f-]+)$/m.exec(result.stdout)?.[1];
  if (result.code !== 0 || id === undefined)
    throw new Error(`Expected a successful run response: ${result.stderr || result.stdout}`);
  return id;
}

export interface RunningCli extends CliSandbox {
  id: string;
  runPath: string;
}

export function startCli(cli: CliSandbox, task: string): RunningCli {
  const id = runId(runCli(['start', 'feature', task], cli));
  return { ...cli, id, runPath: runPath(cli, id) };
}

/**
 * Runs an isolated copy of the built CLI. Reuse a sandbox to test successive invocations.
 * Home and config locations also point into it, never into the developer's real settings.
 */
export function runCli(args: string[], cli?: CliSandbox): CliResult;
export function runCli(
  args: string[],
  cli: CliSandbox,
  options: { async: true },
): Promise<CliResult>;
export function runCli(
  args: string[],
  cli = createCli(),
  options?: { async: true },
): CliResult | Promise<CliResult> {
  const { sandbox, cwd, packageRoot } = cli;
  const commandArgs = [join(packageRoot, 'dist/cli.js'), ...args];
  const settings = {
    cwd,
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
  };
  if (options?.async === true) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, commandArgs, settings);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
      child.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code, stdout, stderr, sandbox });
      });
    });
  }
  const result = spawnSync(process.execPath, commandArgs, { ...settings, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, sandbox };
}
