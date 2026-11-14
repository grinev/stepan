import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyCommit,
  compareVersions,
  parseVersion,
  releaseVersion,
  renderNotes,
  repositoryName,
} from './release.mjs';

const sandboxes = [];
const scripts = fileURLToPath(new URL('.', import.meta.url));
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'stepan-release-'));
  sandboxes.push(home);
  const cwd = join(home, 'проект с пробелами');
  mkdirSync(cwd);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'appdata'),
    XDG_CONFIG_HOME: join(home, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (...args) =>
    execFileSync('git', ['-C', cwd, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const pkg = {
    name: '@grinev/stepan',
    version: '0.0.0',
    repository: { type: 'git', url: 'https://github.com/grinev/stepan.git' },
    dependencies: { yaml: '^2.9.1' },
  };
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    packages: {
      '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
      'node_modules/yaml': { version: '2.9.1', integrity: 'unchanged' },
    },
  };
  for (const [name, data] of [
    ['package.json', pkg],
    ['package-lock.json', lock],
  ])
    writeFileSync(join(cwd, name), `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(join(cwd, 'unrelated.txt'), 'Keep this file.\n');
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-m', 'STP-1: initial implementation');
  return {
    cwd,
    git,
    run(script, args = []) {
      return spawnSync(process.execPath, [join(scripts, script), ...args], {
        cwd,
        env,
        encoding: 'utf8',
      });
    },
  };
}

function files(cwd) {
  const result = {};
  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(cwd, entry.name);
    result[entry.name] = entry.isDirectory() ? files(path) : readFileSync(path, 'utf8');
  }
  return result;
}

function gitState(repo) {
  return {
    head: repo.git('rev-parse', 'HEAD'),
    index: readFileSync(join(repo.cwd, '.git/index')).toString('hex'),
    refs: repo.git('show-ref', '--head'),
    config: readFileSync(join(repo.cwd, '.git/config'), 'utf8'),
  };
}

function json(repo, name) {
  return JSON.parse(readFileSync(join(repo.cwd, name), 'utf8'));
}

function change(repo, subject) {
  repo.git('commit', '--allow-empty', '-m', subject);
}

describe('release versions and notes', () => {
  it.each(['1.2.3', '0.1.0', '0.0.0'])('parses stable version %s', (version) => {
    expect(parseVersion(version)).toEqual(version.split('.').map(Number));
  });
  it.each(['01.2.3', 'v1.2.3', '1.2', '1.2.3-rc.1', '-1.0.0', '1.2.9007199254740992'])(
    'rejects invalid or unsafe stable version %s',
    (version) => {
      expect(() => parseVersion(version)).toThrow();
    },
  );
  it('compares numeric components, not version strings', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.1.0', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
  it.each([
    ['patch', '1.2.4'],
    ['minor', '1.3.0'],
    ['major', '2.0.0'],
    ['1.2.3', '1.2.3'],
    ['3.0.0', '3.0.0'],
  ])('resolves %s to %s', (input, target) => {
    expect(releaseVersion('1.2.3', input)).toBe(target);
  });
  it('refuses downgrades, zero releases and overflowing bumps', () => {
    expect(() => releaseVersion('0.1.0', '0.0.1')).toThrow('downgrade');
    expect(() => releaseVersion('0.0.0', '0.0.0')).toThrow('greater than');
    expect(() => releaseVersion('9007199254740991.0.0', 'major')).toThrow('too large');
  });
  it.each([
    ['feat: add install', 'Changes', 'add install'],
    ['fix(cli): correct output', 'Fixes', 'correct output'],
    ['fix!: remove an option', 'Major Changes', 'remove an option'],
    ['perf: faster reads', 'Changes', 'faster reads'],
    ['docs: clarify usage', 'Technical', 'clarify usage'],
    ['STP-22: install project flows', 'Changes', 'STP-22: install project flows'],
    ['An ordinary subject', 'Changes', 'An ordinary subject'],
  ])('classifies %s', (subject, section, text) => {
    expect(classifyCommit(subject)).toEqual({ section, text });
  });
  it.each(['chore(release): v0.2.0', 'STP-25: chore(release): v0.1.0', 'STP-25: release v0.1.0'])(
    'omits release-only subject %s',
    (subject) => {
      expect(classifyCommit(subject)).toBeNull();
    },
  );
  it('renders only populated sections and a compare footer', () => {
    expect(
      renderNotes(['feat: add install', 'fix: correct output'], 'grinev/stepan', 'v0.1.0', '0.2.0'),
    ).toBe(
      '## Changes\n\n- add install\n\n## Fixes\n\n- correct output\n\n' +
        'Full changelog: https://github.com/grinev/stepan/compare/v0.1.0...v0.2.0\n',
    );
    expect(renderNotes([], 'grinev/stepan', 'v0.1.0', '0.2.0')).toContain('Maintenance release.');
  });
  it.each([
    'https://github.com/grinev/stepan.git',
    'https://github.com/grinev/stepan',
    'git+https://github.com/grinev/stepan.git',
  ])('resolves repository %s', (url) => {
    expect(repositoryName({ repository: { url } })).toBe('grinev/stepan');
    expect(repositoryName({ repository: url })).toBe('grinev/stepan');
  });
  it('rejects invalid repository metadata', () => {
    expect(() => repositoryName({ repository: 'https://example.invalid/repo' })).toThrow('GitHub');
  });
});

describe('release command subprocesses', () => {
  it('prepares the first version without deriving any notes from commits', () => {
    const repo = fixture();
    const before = gitState(repo);
    const result = repo.run('release-prepare.mjs', ['0.1.0']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('First release: write docs/release-notes/v0.1.0.md by hand');
    expect(existsSync(join(repo.cwd, 'docs'))).toBe(false);
    expect(json(repo, 'package.json').version).toBe('0.1.0');
    const lock = json(repo, 'package-lock.json');
    expect(lock.version).toBe('0.1.0');
    expect(lock.packages[''].version).toBe('0.1.0');
    expect(lock.packages['node_modules/yaml']).toEqual({
      version: '2.9.1',
      integrity: 'unchanged',
    });
    expect(readFileSync(join(repo.cwd, 'unrelated.txt'), 'utf8')).toBe('Keep this file.\n');
    expect(gitState(repo)).toEqual(before);
    const snapshot = files(repo.cwd);
    const preview = repo.run('release-notes-preview.mjs');
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('First release: write');
    expect(preview.stdout).not.toContain('initial implementation');
    expect(files(repo.cwd)).toEqual(snapshot);
  });

  it('bumps and seeds a subsequent release, preserves curated notes and previews without writes', () => {
    const repo = fixture();
    repo.git('tag', 'v0.0.0');
    change(repo, 'STP-22: install project flows');
    change(repo, 'fix: report invalid input');
    change(repo, 'chore(release): v0.0.0');
    const before = gitState(repo);
    const result = repo.run('release-prepare.mjs', ['minor']);
    expect(result.status, result.stderr).toBe(0);
    const notesPath = join(repo.cwd, 'docs/release-notes/v0.1.0.md');
    const notes = readFileSync(notesPath, 'utf8');
    expect(notes).toContain('STP-22: install project flows');
    expect(notes).toContain('## Fixes\n\n- report invalid input');
    expect(notes).not.toContain('chore(release)');
    expect(notes).not.toContain('initial implementation');
    expect(notes).toContain('/compare/v0.0.0...v0.1.0');
    writeFileSync(notesPath, 'Hand-curated notes.\n');
    const repeated = repo.run('release-prepare.mjs', ['0.1.0']);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(repeated.stdout).toContain('Keeping existing notes');
    expect(readFileSync(notesPath, 'utf8')).toBe('Hand-curated notes.\n');
    const snapshot = files(repo.cwd);
    const preview = repo.run('release-notes-preview.mjs');
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toBe(notes);
    expect(files(repo.cwd)).toEqual(snapshot);
    expect(gitState(repo)).toEqual(before);
  });

  it('preserves hand-written first-release notes on a repeated prepare', () => {
    const repo = fixture();
    mkdirSync(join(repo.cwd, 'docs/release-notes'), { recursive: true });
    const path = join(repo.cwd, 'docs/release-notes/v0.1.0.md');
    writeFileSync(path, 'Initial features.\n');
    expect(repo.run('release-prepare.mjs', ['0.1.0']).status).toBe(0);
    expect(repo.run('release-prepare.mjs', ['0.1.0']).status).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('Initial features.\n');
  });

  it('excludes a target tag and unrelated or unreachable tags when selecting the previous release', () => {
    const repo = fixture();
    repo.run('release-prepare.mjs', ['0.1.0']);
    repo.git('add', '.');
    change(repo, 'chore(release): v0.1.0');
    repo.git('tag', 'v0.1.0');
    repo.git('tag', 'not-a-release');
    repo.git('tag', 'v0.1.0-rc.1');
    repo.git('checkout', '-b', 'unrelated');
    change(repo, 'feat: unrelated branch');
    repo.git('tag', 'v0.1.1');
    repo.git('checkout', 'main');
    change(repo, 'feat: next capability');
    repo.run('release-prepare.mjs', ['0.2.0']);
    repo.git('tag', 'v0.2.0');
    const snapshot = files(repo.cwd);
    const result = repo.run('release-notes-preview.mjs');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('next capability');
    expect(result.stdout).toContain('/compare/v0.1.0...v0.2.0');
    expect(files(repo.cwd)).toEqual(snapshot);
  });

  it.each([[], ['--unknown'], ['0.1.0', 'extra'], ['bad'], ['0.0.0']].map((args) => ({ args })))(
    'rejects prepare arguments $args without writes',
    ({ args }) => {
      const repo = fixture();
      const snapshot = files(repo.cwd);
      expect(repo.run('release-prepare.mjs', args).status).not.toBe(0);
      expect(files(repo.cwd)).toEqual(snapshot);
    },
  );

  it('rejects a downgrade or an existing tag before changing files', () => {
    const repo = fixture();
    expect(repo.run('release-prepare.mjs', ['0.1.0']).status).toBe(0);
    let snapshot = files(repo.cwd);
    expect(repo.run('release-prepare.mjs', ['0.0.1']).stderr).toContain('downgrade');
    expect(files(repo.cwd)).toEqual(snapshot);
    repo.git('tag', 'v0.2.0');
    snapshot = files(repo.cwd);
    const tagged = repo.run('release-prepare.mjs', ['0.2.0']);
    expect(tagged.status).toBe(1);
    expect(tagged.stderr).toContain('already exists');
    expect(files(repo.cwd)).toEqual(snapshot);
  });

  it('rejects a mismatched lockfile and reports Git errors instead of inventing an initial release', () => {
    const repo = fixture();
    const path = join(repo.cwd, 'package-lock.json');
    const lock = json(repo, 'package-lock.json');
    lock.version = '9.0.0';
    writeFileSync(path, JSON.stringify(lock));
    let snapshot = files(repo.cwd);
    const result = repo.run('release-prepare.mjs', ['0.1.0']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matching names and versions');
    expect(files(repo.cwd)).toEqual(snapshot);
    lock.version = '0.0.0';
    writeFileSync(path, JSON.stringify(lock));
    rmSync(join(repo.cwd, '.git'), { recursive: true, force: true });
    snapshot = files(repo.cwd);
    for (const script of ['release-prepare.mjs', 'release-notes-preview.mjs']) {
      const failed = repo.run(script, script === 'release-prepare.mjs' ? ['0.1.0'] : []);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('git');
      expect(failed.stdout).not.toContain('First release');
      expect(files(repo.cwd)).toEqual(snapshot);
    }
  });

  it('shows help without package or Git access and rejects preview options', () => {
    const repo = fixture();
    rmSync(join(repo.cwd, '.git'), { recursive: true, force: true });
    rmSync(join(repo.cwd, 'package.json'));
    for (const script of ['release-prepare.mjs', 'release-notes-preview.mjs']) {
      const result = repo.run(script, ['--help']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Usage: npm run release:');
    }
    expect(repo.run('release-notes-preview.mjs', ['--unknown']).status).toBe(2);
  });
});
