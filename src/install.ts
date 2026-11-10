import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { loadFlow, readFlowDefinition } from './flow.js';

export interface InstallOptions {
  flow?: string;
  ref?: string;
}

interface Entry {
  mode: string;
  oid: string;
  path: string;
}

const REGULAR = new Set(['100644', '100755']);

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function installSource(source: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source)) {
    return `https://github.com/${source}${source.endsWith('.git') ? '' : '.git'}`;
  }
  if (/^[\w.][\w.-]*@[\w][\w.-]*:[^\s]+$/.test(source)) return source;
  try {
    const url = new URL(source);
    if (
      ['https:', 'ssh:', 'file:'].includes(url.protocol) &&
      !url.hostname.startsWith('-') &&
      url.pathname.length > 1 &&
      !url.search &&
      !url.hash &&
      !url.password
    ) {
      return url.href;
    }
  } catch {
    // Report all unsupported sources with the same actionable message.
  }
  throw new Error('Expected GitHub owner/repo or an HTTPS, SSH, or file:// Git URL');
}

export function validateInstallRef(ref: string): void {
  if (
    !ref ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    hasControl(ref) ||
    /[\s~^:?*\\]/u.test(ref) ||
    ref.includes('[') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock')) ||
    (ref.startsWith('refs/') && !/^refs\/(heads|tags)\//.test(ref))
  ) {
    throw new Error('Expected --ref to name a branch, tag, or commit (not a revision expression)');
  }
}

export function validateInstallPath(path: string): void {
  if (
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          hasControl(part) ||
          /[<>:"\\|?*\ufffd]/u.test(part) ||
          /[. ]$/.test(part) ||
          /^(?:\.git|con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
      )
  ) {
    throw new Error(`Unsafe or non-portable flow path: ${JSON.stringify(path)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function git(cwd: string, args: string[]): Buffer {
  const overrides = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'SSH_ASKPASS_REQUIRE',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_SSH_VARIANT',
  ]);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !overrides.has(key.toUpperCase())),
    ),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes',
    GIT_SSH_VARIANT: 'ssh',
  };
  try {
    return execFileSync(
      'git',
      [
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'protocol.ssh.allow=always',
        '-c',
        'protocol.file.allow=always',
        '-c',
        `core.hooksPath=${join(cwd, '.no-hooks')}`,
        '-c',
        'core.askPass=',
        ...args,
      ],
      {
        cwd,
        env,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Git is required for install; install Git and make it available on PATH', {
        cause: error,
      });
    }
    if (error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') {
      throw new Error('Git timed out after 120 seconds', { cause: error });
    }
    throw new Error(`Git failed: ${message(error)}`, { cause: error });
  }
}

function commitAt(repo: string, ref?: string): string {
  if (ref === undefined)
    return git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  validateInstallRef(ref);
  const refs = git(repo, ['for-each-ref', '--format=%(refname)']).toString().trim().split('\n');
  const matches = ref.startsWith('refs/')
    ? refs.filter((candidate) => candidate === ref)
    : refs.filter(
        (candidate) => candidate === `refs/heads/${ref}` || candidate === `refs/tags/${ref}`,
      );
  if (matches.length > 1) {
    throw new Error(`Ambiguous ref '${ref}': use refs/heads/${ref} or refs/tags/${ref}`);
  }
  const revision = matches[0] ?? (/^[a-fA-F0-9]{7,64}$/.test(ref) ? ref : undefined);
  if (revision === undefined) throw new Error(`No branch, tag, or commit found: ${ref}`);
  return git(repo, ['rev-parse', '--verify', `${revision}^{commit}`])
    .toString()
    .trim();
}

function entriesAt(repo: string, commit: string): Entry[] {
  return git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', '.stepan/flows/'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40,64})\t\.stepan\/flows\/(.+)$/s.exec(
        line,
      );
      if (match === null) throw new Error('Unsupported Git tree entry');
      return { mode: match[1] ?? '', oid: match[2] ?? '', path: match[3] ?? '' };
    });
}

function selectedEntries(entries: Entry[], flow?: string): { names: string[]; entries: Entry[] } {
  const names = [
    ...new Set(
      entries
        .filter((entry) => entry.path.includes('/') || !REGULAR.has(entry.mode))
        .map((entry) => entry.path.split('/')[0] ?? ''),
    ),
  ].sort();
  if (names.length === 0) throw new Error('No flows found in the source .stepan/flows/');
  if (flow !== undefined && !names.includes(flow))
    throw new Error(`No flow found in source: ${flow}`);
  const selected = flow === undefined ? names : [flow];
  const paths = new Map<string, string>();
  const files = entries.filter((entry) => selected.includes(entry.path.split('/')[0] ?? ''));
  for (const entry of files) {
    validateInstallPath(entry.path);
    if (!REGULAR.has(entry.mode))
      throw new Error(`Only regular files can be installed: ${entry.path}`);
    const parts = entry.path.split('/');
    for (let end = 1; end <= parts.length; end++) {
      const path = parts.slice(0, end).join('/');
      const key = path.normalize('NFC').toLowerCase();
      const prior = paths.get(key);
      if (prior !== undefined && prior !== path)
        throw new Error(`Flow path collision: ${prior} and ${path}`);
      paths.set(key, path);
    }
  }
  return { names: selected, entries: files };
}

function directory(path: string): void {
  try {
    mkdirSync(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Expected a real directory: ${path}`, { cause: error });
  }
}

function checkDestinations(base: string, names: string[]): void {
  const existing = new Set(readdirSync(base).map((name) => name.normalize('NFC').toLowerCase()));
  for (const name of names) {
    if (existing.has(name.normalize('NFC').toLowerCase())) {
      throw new Error(`Flow destination already exists: ${join(base, name)}`);
    }
  }
}

/** Installs a validated snapshot without checking out or executing the source. */
export function installFlows(root: string, source: string, options: InstallOptions = {}): string {
  const url = installSource(source);
  if (options.ref !== undefined) validateInstallRef(options.ref);
  if (options.flow !== undefined) {
    validateInstallPath(options.flow);
    if (options.flow.includes('/')) throw new Error('Expected --flow to name one flow directory');
  }
  directory(root);
  const stepan = join(root, '.stepan');
  directory(stepan);
  const temp = mkdtempSync(join(stepan, '.install-'));
  const created: string[] = [];
  let result = '';
  let failure: Error | undefined;
  try {
    const repo = join(temp, 'repo.git');
    const template = join(temp, 'empty-template');
    mkdirSync(template);
    git(temp, ['clone', '--bare', '--no-local', `--template=${template}`, '--', url, repo]);
    const commit = commitAt(repo, options.ref);
    const selected = selectedEntries(entriesAt(repo, commit), options.flow);
    const stage = join(temp, 'stage');
    const content = new Map<string, { bytes: Buffer; mode: number }>();
    for (const entry of selected.entries) {
      const bytes = git(repo, ['cat-file', 'blob', entry.oid]);
      const mode = entry.mode === '100755' ? 0o755 : 0o644;
      content.set(entry.path, { bytes, mode });
      const file = join(stage, '.stepan', 'flows', entry.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { flag: 'wx', mode });
    }
    for (const name of selected.names) {
      const definition = readFlowDefinition(join(stage, '.stepan', 'flows', name));
      for (const [id, step] of Object.entries(definition.steps)) {
        validateInstallPath(step.instruction);
        if (posix.isAbsolute(step.instruction))
          throw new Error(`steps.${id}.instruction must stay inside its flow`);
        if (!content.has(`${name}/${step.instruction}`)) {
          throw new Error(
            `steps.${id}.instruction is not a file inside flow '${name}': ${step.instruction}`,
          );
        }
      }
      loadFlow(stage, name);
    }
    const base = join(stepan, 'flows');
    directory(base);
    checkDestinations(base, selected.names);
    for (const name of selected.names) {
      const target = join(base, name);
      mkdirSync(target);
      created.push(target);
    }
    for (const [path, { bytes, mode }] of content) {
      const target = join(base, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx', mode });
    }
    result = `Installed from ${url} at ${commit}:\n${selected.names.map((name) => `  ${join(base, name)}`).join('\n')}\n`;
  } catch (error) {
    const failures: string[] = [];
    for (const target of created) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (rollback) {
        failures.push(`${target}: ${message(rollback)}`);
      }
    }
    failure =
      failures.length > 0
        ? new Error(`${message(error)}; rollback failed: ${failures.join('; ')}`, { cause: error })
        : error instanceof Error
          ? error
          : new Error(message(error), { cause: error });
  } finally {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch (error) {
      failure = new Error(
        `${failure === undefined ? '' : `${message(failure)}; `}Could not clean installation temporary directory ${temp}: ${message(error)}`,
        { cause: error },
      );
    }
  }
  if (failure !== undefined) throw failure;
  return result;
}
