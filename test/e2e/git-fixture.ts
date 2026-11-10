import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CliSandbox } from './run-cli.js';

export function gitEnv(cli: CliSandbox): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: cli.sandbox,
    USERPROFILE: cli.sandbox,
    APPDATA: join(cli.sandbox, 'AppData'),
    XDG_CONFIG_HOME: join(cli.sandbox, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(cli.sandbox, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function fixtureGit(cli: CliSandbox, repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env: gitEnv(cli),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function gitRepository(cli: CliSandbox): { repo: string; url: string } {
  const repo = join(cli.sandbox, 'коллекция с пробелами');
  mkdirSync(repo);
  fixtureGit(cli, repo, 'init', '--initial-branch=main');
  fixtureGit(cli, repo, 'config', 'user.name', 'Fixture');
  fixtureGit(cli, repo, 'config', 'user.email', 'fixture@example.invalid');
  fixtureGit(cli, repo, 'config', 'core.autocrlf', 'false');
  return { repo, url: pathToFileURL(repo).href };
}

export function commitFixture(cli: CliSandbox, repo: string): string {
  fixtureGit(cli, repo, 'add', '.');
  fixtureGit(cli, repo, 'commit', '--no-gpg-sign', '-m', 'Fixture');
  return fixtureGit(cli, repo, 'rev-parse', 'HEAD');
}

export function simpleFlow(repo: string, name: string, instruction = `Complete ${name}.`): void {
  const directory = join(repo, '.stepan', 'flows', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'flow.yaml'),
    'start: finish\nsteps:\n  finish:\n    instruction: finish.md\n',
  );
  writeFileSync(join(directory, 'finish.md'), instruction);
}

export function exampleFixture(repo: string): void {
  const source = fileURLToPath(new URL('../fixtures/example/', import.meta.url));
  const destination = join(repo, '.stepan/flows/example');
  mkdirSync(join(destination, 'steps'), { recursive: true });
  copyFileSync(join(source, 'flow.yaml'), join(destination, 'flow.yaml'));
  for (const file of readdirSync(join(source, 'steps'))) {
    copyFileSync(join(source, 'steps', file), join(destination, 'steps', file));
  }
}
