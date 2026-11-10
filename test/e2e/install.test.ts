import {
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCli, runCli, type CliSandbox } from './run-cli.js';
import { commitFixture, fixtureGit, gitRepository, simpleFlow } from './git-fixture.js';

function fixture(layout: 'installed' | 'sources' = 'installed') {
  const cli = createCli(layout);
  const { repo, url } = gitRepository(cli);
  simpleFlow(repo, 'alpha');
  simpleFlow(repo, 'beta');
  const commit = commitFixture(cli, repo);
  return { cli, repo, url, commit };
}

function installed(cli: CliSandbox): string[] {
  const path = join(cli.root, '.stepan/flows');
  return existsSync(path) ? readdirSync(path) : [];
}

function expectClean(cli: CliSandbox): void {
  const path = join(cli.root, '.stepan');
  if (existsSync(path))
    expect(readdirSync(path).filter((name) => name.startsWith('.install-'))).toEqual([]);
  expect(existsSync(cli.runsDirectory)).toBe(false);
}

function preload(cli: CliSandbox, code: string): void {
  const path = join(cli.sandbox, 'fault.mjs');
  writeFileSync(
    path,
    `import fs from 'node:fs';\nimport cp from 'node:child_process';\nimport {syncBuiltinESMExports} from 'node:module';\n${code}\nsyncBuiltinESMExports();\n`,
  );
  cli.nodeArgs = ['--import', pathToFileURL(path).href];
}

describe('stepan install', () => {
  it.each(['installed', 'sources'] as const)(
    'installs all flows only under writeRoot in %s mode',
    (layout) => {
      const { cli, repo, url, commit } = fixture(layout);
      mkdirSync(join(repo, '.stepan/runs'));
      writeFileSync(join(repo, '.stepan/runs/ignored.json'), 'private');
      writeFileSync(join(repo, 'ignored.txt'), 'private');
      commitFixture(cli, repo);
      const result = runCli(['install', url, '--ref', commit], cli);
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toContain(commit);
      expect(installed(cli)).toEqual(['alpha', 'beta']);
      expect(readFileSync(join(cli.root, '.stepan/flows/alpha/finish.md'), 'utf8')).toBe(
        'Complete alpha.',
      );
      expect(existsSync(join(cli.root, 'ignored.txt'))).toBe(false);
      if (layout === 'sources') expect(existsSync(join(cli.cwd, '.stepan'))).toBe(false);
      expectClean(cli);
    },
  );

  it.each(['owner/repo', 'https://github.com/owner/repo.git'])(
    'supports %s without external network',
    (source) => {
      const { cli, url } = fixture();
      fixtureGit(
        cli,
        cli.cwd,
        'config',
        '--global',
        `url.${url}.insteadOf`,
        'https://github.com/owner/repo.git',
      );
      expect(runCli(['install', source, '--flow', 'alpha'], cli)).toMatchObject({
        code: 0,
        stderr: '',
      });
      expect(installed(cli)).toEqual(['alpha']);
      expectClean(cli);
    },
  );

  it.each(['default', 'branch', 'tag', 'commit'])('selects the requested %s snapshot', (kind) => {
    const { cli, repo, url, commit } = fixture();
    fixtureGit(cli, repo, 'branch', 'older');
    fixtureGit(cli, repo, 'tag', '-a', 'v1', '-m', 'Version');
    writeFileSync(join(repo, '.stepan/flows/alpha/finish.md'), 'New version');
    const latest = commitFixture(cli, repo);
    const ref = { branch: 'older', tag: 'v1', commit, default: undefined }[kind];
    const result = runCli(
      ['install', url, '--flow', 'alpha', ...(ref === undefined ? [] : ['--ref', ref])],
      cli,
    );
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain(kind === 'default' ? latest : commit);
    expect(readFileSync(join(cli.root, '.stepan/flows/alpha/finish.md'), 'utf8')).toBe(
      kind === 'default' ? 'New version' : 'Complete alpha.',
    );
  });

  it('refuses an ambiguous ref and permits explicit branch/tag namespaces', () => {
    const { cli, repo, url } = fixture();
    fixtureGit(cli, repo, 'tag', 'main');
    expect(runCli(['install', url, '--ref', 'main'], cli)).toMatchObject({ code: 1, stdout: '' });
    expect(installed(cli)).toEqual([]);
    expect(
      runCli(['install', url, '--flow', 'alpha', '--ref', 'refs/tags/main'], cli),
    ).toMatchObject({ code: 0 });
    expect(
      runCli(['install', url, '--flow', 'beta', '--ref', 'refs/heads/main'], cli),
    ).toMatchObject({ code: 0 });
  });

  it('does not partially install when another destination exists', () => {
    const { cli, url } = fixture();
    const destination = join(cli.root, '.stepan/flows/beta');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'preserved'), 'User work');
    const result = runCli(['install', url], cli);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain('already exists');
    expect(installed(cli)).toEqual(['beta']);
    expect(readFileSync(join(destination, 'preserved'), 'utf8')).toBe('User work');
    expectClean(cli);
  });

  it.each([
    'missing-flow',
    'missing-ref',
    'invalid-flow',
    'missing-instruction',
    'outside-instruction',
    'case-collision',
    'symlink',
    'submodule',
    'non-portable',
    'empty',
    'bad-source',
  ])('refuses %s without leaving installed flows', (scenario) => {
    const { cli, repo, url, commit } = fixture();
    const args: string[] = [];
    if (scenario === 'missing-flow') args.push('--flow', 'absent');
    if (scenario === 'missing-ref') args.push('--ref', 'absent');
    if (scenario === 'invalid-flow')
      writeFileSync(join(repo, '.stepan/flows/beta/flow.yaml'), 'unknown: true');
    if (scenario === 'missing-instruction' || scenario === 'outside-instruction') {
      writeFileSync(
        join(repo, '.stepan/flows/beta/flow.yaml'),
        `start: finish\nsteps:\n  finish:\n    instruction: ${scenario === 'missing-instruction' ? 'absent.md' : '../../outside.md'}\n`,
      );
    }
    if (
      scenario === 'symlink' ||
      scenario === 'submodule' ||
      scenario === 'case-collision' ||
      scenario === 'non-portable'
    ) {
      const mode =
        scenario === 'symlink' ? '120000' : scenario === 'submodule' ? '160000' : '100644';
      const oid =
        scenario === 'submodule'
          ? commit
          : fixtureGit(cli, repo, 'rev-parse', 'HEAD:.stepan/flows/beta/finish.md');
      const path =
        scenario === 'case-collision'
          ? '.stepan/flows/beta/Finish.md'
          : scenario === 'non-portable'
            ? '.stepan/flows/beta/NUL.md'
            : '.stepan/flows/beta/link';
      fixtureGit(
        cli,
        repo,
        '-c',
        'core.protectNTFS=false',
        'update-index',
        '--add',
        '--cacheinfo',
        `${mode},${oid},${path}`,
      );
      fixtureGit(cli, repo, 'commit', '--no-gpg-sign', '-m', 'Unsafe entry');
    } else if (scenario === 'empty') {
      fixtureGit(cli, repo, 'rm', '-r', '.stepan');
      fixtureGit(cli, repo, 'commit', '--no-gpg-sign', '-m', 'No flows');
    } else if (['invalid-flow', 'missing-instruction', 'outside-instruction'].includes(scenario)) {
      commitFixture(cli, repo);
    }
    const result = runCli(
      [
        'install',
        scenario === 'bad-source' ? pathToFileURL(join(cli.sandbox, 'absent')).href : url,
        ...args,
      ],
      cli,
    );
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).not.toBe('');
    expect(installed(cli)).toEqual([]);
    expectClean(cli);
  });

  it.each(['.stepan', '.stepan/flows', '.stepan/flows/alpha'])(
    'does not follow destination junction %s',
    (path) => {
      const { cli, url } = fixture();
      const outside = join(cli.sandbox, 'outside');
      mkdirSync(outside);
      const target = join(cli.cwd, path);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(outside, target, 'junction');
      expect(runCli(['install', url], cli)).toMatchObject({ code: 1, stdout: '' });
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  it('installs Unicode flow names and filenames with spaces', () => {
    const { cli, repo, url } = fixture();
    simpleFlow(repo, 'пример с пробелами', 'Готово.');
    commitFixture(cli, repo);
    expect(runCli(['install', url, '--flow', 'пример с пробелами'], cli)).toMatchObject({
      code: 0,
      stderr: '',
    });
    expect(installed(cli)).toEqual(['пример с пробелами']);
    expect(runCli(['start', 'пример с пробелами', 'Задача'], cli).stdout).toContain('Готово.');
  });

  it('does not execute reference-transaction hooks, checkout hooks or configured smudge filters', () => {
    const { cli, repo, url } = fixture();
    const marker = join(cli.sandbox, 'executed');
    const hook = join(cli.sandbox, 'hooks');
    mkdirSync(hook);
    writeFileSync(
      join(hook, 'post-checkout'),
      `#!/bin/sh\nprintf unsafe > '${marker.replaceAll('\\', '/')}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(hook, 'reference-transaction'),
      `#!/bin/sh\nprintf unsafe > '${marker.replaceAll('\\', '/')}'\n`,
      { mode: 0o755 },
    );
    fixtureGit(cli, cli.cwd, 'config', '--global', 'core.hooksPath', hook);
    fixtureGit(
      cli,
      cli.cwd,
      'config',
      '--global',
      'filter.unsafe.smudge',
      `echo unsafe > "${marker}"`,
    );
    writeFileSync(join(repo, '.stepan/flows/alpha/.gitattributes'), '*.md filter=unsafe\n');
    commitFixture(cli, repo);
    // The fixture commit itself also runs reference-transaction; clear its marker.
    if (existsSync(marker)) unlinkSync(marker);
    expect(runCli(['install', url], cli)).toMatchObject({ code: 0, stderr: '' });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(cli.root, '.stepan/flows/alpha/finish.md'), 'utf8')).toBe(
      'Complete alpha.',
    );
  });

  it('suppresses configured askpass and uses noninteractive OpenSSH', () => {
    const { cli, url } = fixture();
    const marker = join(cli.sandbox, 'askpass-executed');
    const helper = join(cli.sandbox, 'askpass.mjs');
    writeFileSync(
      helper,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log('secret');`,
    );
    const askpass = `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`;
    fixtureGit(cli, cli.cwd, 'config', '--global', 'core.askPass', askpass);
    cli.env = { GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, GIT_SSH_COMMAND: 'unsafe-wrapper' };
    preload(
      cli,
      `
      const original = cp.execFileSync;
      let checked = false;
      cp.execFileSync = function(file, args, options) {
        if (!checked && args.includes('clone')) {
          checked = true;
          if (options.env.GIT_ASKPASS !== '' || options.env.SSH_ASKPASS !== '' || options.env.SSH_ASKPASS_REQUIRE !== 'never' || options.env.GIT_SSH_COMMAND !== 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes') throw new Error('Interactive authentication allowed');
          try { original(file, [...args.slice(0, args.indexOf('clone')), 'credential', 'fill'], {...options, stdio:['pipe','pipe','pipe'], input:'protocol=https\\nhost=auth.example.invalid\\n\\n'}); }
          catch(error) { if(!String(error).includes('terminal prompts disabled')) throw error; }
        }
        return original(file, args, options);
      };
    `,
    );
    expect(runCli(['install', url], cli)).toMatchObject({ code: 0, stderr: '' });
    expect(existsSync(marker)).toBe(false);
  });

  it('preserves executable files from the selected Git tree', () => {
    const { cli, repo, url } = fixture();
    const script = '.stepan/flows/alpha/check.sh';
    writeFileSync(join(repo, script), '#!/bin/sh\nexit 0\n');
    fixtureGit(cli, repo, 'add', '.');
    fixtureGit(cli, repo, 'update-index', '--chmod=+x', script);
    fixtureGit(cli, repo, 'commit', '--no-gpg-sign', '-m', 'Executable artifact');
    expect(runCli(['install', url, '--flow', 'alpha'], cli)).toMatchObject({ code: 0, stderr: '' });
    const installedScript = join(cli.root, script);
    expect(readFileSync(installedScript, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') expect(statSync(installedScript).mode & 0o111).not.toBe(0);
  });

  it.each(['missing-git', 'timeout', 'rollback', 'cleanup'])(
    'reports %s through the binary and preserves unrelated files',
    (scenario) => {
      const { cli, url } = fixture();
      const preserved = join(cli.root, '.stepan/flows/preserved');
      mkdirSync(preserved, { recursive: true });
      writeFileSync(join(preserved, 'user.txt'), 'User work');
      if (scenario === 'missing-git') cli.env = { PATH: '' };
      if (scenario === 'timeout')
        preload(
          cli,
          `cp.execFileSync = () => { throw Object.assign(new Error('Timed out'), {code:'ETIMEDOUT'}); };`,
        );
      if (scenario === 'rollback')
        preload(
          cli,
          `const write = fs.writeFileSync; fs.writeFileSync = function(path, ...args) { if(String(path).startsWith(${JSON.stringify(join(cli.root, '.stepan/flows/beta'))})) throw new Error('Injected write failure'); return write(path, ...args); };`,
        );
      if (scenario === 'cleanup')
        preload(
          cli,
          `const remove = fs.rmSync; fs.rmSync = function(path, ...args) { if(String(path).includes('.install-')) throw new Error('Injected cleanup failure'); return remove(path, ...args); };`,
        );
      const result = runCli(['install', url], cli);
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain(
        {
          'missing-git': 'Git is required',
          timeout: 'timed out',
          rollback: 'Injected write failure',
          cleanup: 'Could not clean',
        }[scenario],
      );
      expect(readFileSync(join(preserved, 'user.txt'), 'utf8')).toBe('User work');
      if (scenario !== 'cleanup') {
        expect(installed(cli)).toEqual(['preserved']);
        expectClean(cli);
      }
    },
  );

  it.each([
    [],
    ['owner/repo', 'extra'],
    ['owner/repo', '--unknown'],
    ['owner/repo', '--flow'],
    ['owner/repo', '--flow', ''],
    ['owner/repo', '--ref', ''],
    ['owner/repo', '--ref=-bad'],
    ['owner/repo', '--ref', 'HEAD~1'],
    ['owner/repo', '--flow', '../outside'],
    ['owner/repo', '--flow', 'alpha', '--flow', 'beta'],
    ['owner/repo', '--ref', 'main', '--ref', 'main'],
    ['--help', 'owner/repo'],
    ['--help', '-h'],
    ['ext::unsafe'],
  ])('rejects usage before creating state (%#)', (...args) => {
    const cli = createCli();
    expect(runCli(['install', ...args], cli)).toMatchObject({ code: 2, stdout: '' });
    expect(existsSync(join(cli.root, '.stepan'))).toBe(false);
  });

  it('prints standalone help without Git or filesystem access', () => {
    const cli = createCli();
    cli.env = { PATH: '' };
    expect(runCli(['install', '--help'], cli)).toMatchObject({ code: 0, stderr: '' });
    expect(runCli(['--help'], cli).stdout).toContain('install <source>');
    expect(existsSync(join(cli.root, '.stepan'))).toBe(false);
  });
});
