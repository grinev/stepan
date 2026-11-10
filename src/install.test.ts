import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFlows, installSource, validateInstallPath, validateInstallRef } from './install.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
}));
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

const roots: string[] = [];
const COMMIT = 'a'.repeat(40);
const YAML = 'start: finish\nsteps:\n  finish:\n    instruction: finish.md\n';
const files = new Map([
  ['feature/flow.yaml', YAML],
  ['feature/finish.md', 'Finish.'],
]);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), 'stepan-install-unit-'));
  roots.push(directory);
  return directory;
}

function mockGit(content = files, refs = 'refs/heads/main\nrefs/tags/v1', mode = '100644') {
  const paths = [...content.keys()];
  return vi.spyOn(childProcess, 'execFileSync').mockImplementation((_file, args) => {
    const words = args as readonly string[];
    if (words.includes('clone')) return Buffer.alloc(0);
    if (words.includes('for-each-ref')) return Buffer.from(refs);
    if (words.includes('rev-parse')) return Buffer.from(COMMIT);
    if (words.includes('ls-tree')) {
      return Buffer.from(
        paths
          .map(
            (path, index) =>
              `${mode} blob ${String(index).padStart(40, '0')}\t.stepan/flows/${path}\0`,
          )
          .join(''),
      );
    }
    if (words.includes('cat-file')) {
      return Buffer.from(content.get(paths[Number(words.at(-1))] ?? '') ?? '');
    }
    throw new Error(`Unexpected Git call: ${words.join(' ')}`);
  });
}

describe('install sources', () => {
  it.each([
    ['grinev/stepan-flows', 'https://github.com/grinev/stepan-flows.git'],
    ['grinev/stepan-flows.git', 'https://github.com/grinev/stepan-flows.git'],
    ['https://example.org/flows.git', 'https://example.org/flows.git'],
    ['ssh://git@example.org/team/flows.git', 'ssh://git@example.org/team/flows.git'],
    ['git@example.org:team/flows.git', 'git@example.org:team/flows.git'],
    ['file:///tmp/collection', 'file:///tmp/collection'],
  ])('accepts %s', (source, expected) => {
    expect(installSource(source)).toBe(expected);
  });

  it.each([
    '',
    '-option',
    '../local',
    'repo',
    'ext::command',
    'http://host/repo',
    'https://host/',
    'https://host/repo#ref',
    'https://host/repo?q=1',
    'https://user:secret@host/repo',
    'git@-host:repo',
    'ssh://-host/repo',
  ])('refuses unsupported source %j', (source) => {
    expect(() => installSource(source)).toThrow();
  });
});

describe('install refs and paths', () => {
  it.each(['main', 'feature/install', 'v1.0.0', 'refs/heads/main', 'refs/tags/v1', COMMIT])(
    'accepts ref %s',
    (ref) => {
      expect(() => {
        validateInstallRef(ref);
      }).not.toThrow();
    },
  );
  it.each([
    '',
    '-main',
    'HEAD~1',
    'main^{commit}',
    'main:flow.yaml',
    'a..b',
    'a@{0}',
    'a//b',
    'refs/remotes/a',
    '/main',
    'main/',
    '.hidden',
    'a.lock',
    'a?b',
    'a b',
  ])('rejects ref %j', (ref) => {
    expect(() => {
      validateInstallRef(ref);
    }).toThrow();
  });

  it.each(['feature/flow.yaml', 'пример с пробелами/steps/finish.md', '.gitattributes'])(
    'accepts portable path %s',
    (path) => {
      expect(() => {
        validateInstallPath(path);
      }).not.toThrow();
    },
  );
  it.each([
    '',
    '/absolute',
    '../outside',
    'a/../b',
    'a/./b',
    'a//b',
    'a\\b',
    'C:/file',
    'a\nfile',
    'a\x7ffile',
    'NUL.md',
    'con',
    'COM1.txt',
    'lpt²',
    '.git/config',
    'ends.',
    'ends ',
    'a*b',
    'a?b',
    'a|b',
    'a<b',
    'a\ufffdb',
  ])('rejects unsafe path %j', (path) => {
    expect(() => {
      validateInstallPath(path);
    }).toThrow();
  });
});

describe('install snapshot', () => {
  it('uses bare objects, validates and installs without adding provenance files', () => {
    const spy = mockGit();
    const destination = root();
    expect(installFlows(destination, 'owner/repo')).toContain(`at ${COMMIT}`);
    expect(fs.readFileSync(join(destination, '.stepan/flows/feature/finish.md'), 'utf8')).toBe(
      'Finish.',
    );
    expect(fs.readdirSync(join(destination, '.stepan'))).toEqual(['flows']);
    const calls = spy.mock.calls.map((call) => call[1] as readonly string[]);
    expect(calls[0]).toEqual(expect.arrayContaining(['clone', '--bare', '--no-local']));
    expect(calls.some((args) => args.includes('checkout'))).toBe(false);
  });

  it('overrides hooks, askpass and interactive SSH on every Git invocation', () => {
    vi.stubEnv('GIT_ASKPASS', 'unsafe-helper');
    vi.stubEnv('GIT_SSH_COMMAND', 'unsafe-ssh-wrapper');
    vi.stubEnv('GIT_DIR', 'unrelated');
    const spy = mockGit();
    installFlows(root(), 'owner/repo');
    for (const call of spy.mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(['core.askPass=']));
      expect((call[1] as readonly string[]).some((arg) => arg.startsWith('core.hooksPath='))).toBe(
        true,
      );
      expect(call[2]).toMatchObject({
        env: {
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          SSH_ASKPASS_REQUIRE: 'never',
          GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes',
          GIT_SSH_VARIANT: 'ssh',
        },
      });
      expect(call[2]?.env).not.toHaveProperty('GIT_DIR');
    }
  });

  it('preserves the executable flag of regular files', () => {
    mockGit(files, '', '100755');
    const destination = root();
    const realWrite = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(realWrite);
    installFlows(destination, 'owner/repo');
    expect(spy).toHaveBeenCalledWith(
      join(destination, '.stepan/flows/feature/finish.md'),
      expect.any(Buffer),
      { flag: 'wx', mode: 0o755 },
    );
    if (process.platform !== 'win32')
      expect(
        fs.statSync(join(destination, '.stepan/flows/feature/finish.md')).mode & 0o111,
      ).not.toBe(0);
  });

  it.each(['main', 'v1', 'refs/heads/main', COMMIT, COMMIT.slice(0, 8)])(
    'resolves ref %s',
    (ref) => {
      mockGit();
      expect(installFlows(root(), 'owner/repo', { ref })).toContain(COMMIT);
    },
  );

  it.each([
    ['missing', 'refs/heads/main', 'No branch, tag, or commit'],
    ['main', 'refs/heads/main\nrefs/tags/main', 'Ambiguous ref'],
  ])('rejects missing or ambiguous ref %s', (ref, refs, error) => {
    mockGit(files, refs);
    const destination = root();
    expect(() => installFlows(destination, 'owner/repo', { ref })).toThrow(error);
    expect(fs.readdirSync(join(destination, '.stepan'))).toEqual([]);
  });

  it.each([
    [new Map<string, string>(), 'No flows found'],
    [new Map([['feature/flow.yaml', 'unknown: true']]), 'unknown key'],
    [new Map([['feature/flow.yaml', YAML]]), 'not a file inside flow'],
    [new Map([['feature/flow.yaml', YAML.replace('finish.md', '../outside.md')]]), 'Unsafe'],
    [
      new Map([
        ['feature/flow.yaml', YAML],
        ['feature/finish.md', ''],
        ['feature/Finish.md', ''],
      ]),
      'collision',
    ],
  ])('refuses an invalid snapshot before installation (%#)', (content, error) => {
    mockGit(content);
    const destination = root();
    expect(() => installFlows(destination, 'owner/repo')).toThrow(error);
    expect(fs.readdirSync(join(destination, '.stepan'))).toEqual([]);
  });

  it('ignores an unselected invalid flow and root collection files', () => {
    mockGit(new Map([...files, ['broken/flow.yaml', 'invalid'], ['README.md', 'Collection']]));
    const destination = root();
    expect(installFlows(destination, 'owner/repo', { flow: 'feature' })).toContain(COMMIT);
    expect(fs.readdirSync(join(destination, '.stepan/flows'))).toEqual(['feature']);
  });

  it.each(['120000', '160000'])('rejects non-regular Git mode %s before installation', (mode) => {
    mockGit(files, '', mode);
    const destination = root();
    expect(() => installFlows(destination, 'owner/repo')).toThrow('Only regular files');
    expect(fs.readdirSync(join(destination, '.stepan'))).toEqual([]);
  });

  it('refuses an unsupported tree response and a missing selected flow', () => {
    const spy = mockGit();
    expect(() => installFlows(root(), 'owner/repo', { flow: 'absent' })).toThrow('No flow found');
    const realMock = spy.getMockImplementation();
    spy.mockImplementation((file, args, options) => {
      if ((args as readonly string[]).includes('ls-tree')) return Buffer.from('unsupported\0');
      return realMock?.(file, args, options) ?? Buffer.alloc(0);
    });
    expect(() => installFlows(root(), 'owner/repo')).toThrow('Unsupported Git tree');
  });

  it('refuses existing targets including case-insensitive names', () => {
    mockGit();
    const destination = root();
    fs.mkdirSync(join(destination, '.stepan/flows/FEATURE'), { recursive: true });
    expect(() => installFlows(destination, 'owner/repo')).toThrow('already exists');
    expect(fs.readdirSync(join(destination, '.stepan/flows'))).toEqual(['FEATURE']);
  });

  it('refuses a non-directory write parent before Git access', () => {
    const spy = mockGit();
    const destination = root();
    fs.writeFileSync(join(destination, '.stepan'), 'User work');
    expect(() => installFlows(destination, 'owner/repo')).toThrow('Expected a real directory');
    expect(spy).not.toHaveBeenCalled();
    expect(fs.readFileSync(join(destination, '.stepan'), 'utf8')).toBe('User work');
  });

  it('rolls back only directories created by this invocation', () => {
    mockGit();
    const destination = root();
    const preserved = join(destination, '.stepan/flows/preserved');
    fs.mkdirSync(preserved, { recursive: true });
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).startsWith(join(destination, '.stepan/flows/feature')))
        throw new Error('Write failed');
      realWrite(file, data, options);
    });
    expect(() => installFlows(destination, 'owner/repo')).toThrow('Write failed');
    expect(fs.readdirSync(join(destination, '.stepan/flows'))).toEqual(['preserved']);
    expect(fs.readdirSync(join(destination, '.stepan'))).toEqual(['flows']);
  });

  it('reports rollback failure without hiding the original error', () => {
    mockGit();
    const destination = root();
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).startsWith(join(destination, '.stepan/flows/feature')))
        throw new Error('Write failed');
      realWrite(file, data, options);
    });
    const realRemove = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path) === join(destination, '.stepan/flows/feature'))
        throw new Error('Remove failed');
      realRemove(path, options);
    });
    expect(() => installFlows(destination, 'owner/repo')).toThrow(
      /Write failed; rollback failed:.*Remove failed/,
    );
  });

  it('reports cleanup failure explicitly', () => {
    mockGit();
    const destination = root();
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('Cleanup failed');
    });
    expect(() => installFlows(destination, 'owner/repo')).toThrow(
      'Could not clean installation temporary directory',
    );
  });

  it.each([
    ['ENOENT', 'Git is required'],
    ['ETIMEDOUT', 'Git timed out'],
    ['EIO', 'Git failed'],
  ])('reports Git failure %s and cleans temporary files', (code, error) => {
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw Object.assign(new Error('Failed'), { code });
    });
    const destination = root();
    expect(() => installFlows(destination, 'owner/repo')).toThrow(error);
    expect(fs.readdirSync(join(destination, '.stepan'))).toEqual([]);
  });
});
