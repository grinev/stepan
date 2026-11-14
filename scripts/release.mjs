import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SECTIONS = ['Major Changes', 'Changes', 'Fixes', 'Technical'];

export function parseVersion(version) {
  if (typeof version !== 'string' || !VERSION.test(version))
    throw new Error(`Invalid stable version: ${String(version)}. Expected X.Y.Z.`);
  const parts = version.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error(`Version component is too large: ${version}.`);
  return parts;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function releaseVersion(current, input) {
  const parts = parseVersion(current);
  const index = ['major', 'minor', 'patch'].indexOf(input);
  if (index >= 0) {
    parts[index]++;
    parts.fill(0, index + 1);
  }
  const target = index >= 0 ? parts.join('.') : input;
  parseVersion(target);
  if (target === '0.0.0') throw new Error('A release version must be greater than 0.0.0.');
  if (compareVersions(target, current) < 0)
    throw new Error(`Cannot downgrade from ${current} to ${target}.`);
  return target;
}

export function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function readManifests(cwd) {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
  parseVersion(pkg.version);
  if (
    lock.lockfileVersion !== 3 ||
    lock.version !== pkg.version ||
    lock.name !== pkg.name ||
    lock.packages?.['']?.version !== pkg.version ||
    lock.packages[''].name !== pkg.name
  )
    throw new Error(
      'package.json and the v3 package-lock.json must have matching names and versions.',
    );
  return { pkg, lock };
}

export function previousReleaseTag(cwd, version) {
  git(cwd, ['rev-parse', '--verify', 'HEAD']);
  const tags = git(cwd, ['tag', '--merged', 'HEAD', '--list'])
    .split(/\r?\n/)
    .filter((tag) => VERSION.test(tag.slice(1)) && tag.startsWith('v'))
    .filter((tag) => compareVersions(tag.slice(1), version) < 0);
  if (tags.length === 0) return null;
  return git(cwd, [
    'describe',
    '--tags',
    '--abbrev=0',
    ...tags.flatMap((tag) => ['--match', tag]),
    'HEAD',
  ]);
}

export function classifyCommit(subject) {
  if (
    /^(?:STP-\d+:\s*)?chore\(release\):/i.test(subject) ||
    /^STP-\d+:\s*release v\d+\.\d+\.\d+$/i.test(subject)
  )
    return null;
  const match = /^([a-z]+)(?:\([^)]*\))?(!)?:\s*(.+)$/i.exec(subject);
  if (!match) return { section: 'Changes', text: subject };
  const [, type, breaking, text] = match;
  if (breaking) return { section: 'Major Changes', text };
  if (['fix', 'revert'].includes(type.toLowerCase())) return { section: 'Fixes', text };
  if (['feat', 'perf'].includes(type.toLowerCase())) return { section: 'Changes', text };
  return { section: 'Technical', text };
}

export function repositoryName(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const match =
    typeof url === 'string'
      ? /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
          url,
        )
      : null;
  if (!match) throw new Error('package.json repository must be a GitHub HTTPS URL.');
  return `${match[1]}/${match[2]}`;
}

export function renderNotes(subjects, repository, previous, version) {
  const sections = new Map(SECTIONS.map((section) => [section, []]));
  for (const subject of subjects) {
    const entry = classifyCommit(subject);
    if (entry) sections.get(entry.section).push(`- ${entry.text}`);
  }
  const blocks = [...sections]
    .filter(([, items]) => items.length > 0)
    .map(([section, items]) => `## ${section}\n\n${items.join('\n')}`);
  if (blocks.length === 0) blocks.push('- Maintenance release.');
  blocks.push(`Full changelog: https://github.com/${repository}/compare/${previous}...v${version}`);
  return `${blocks.join('\n\n')}\n`;
}

export function generateNotes(cwd, pkg, version) {
  const previous = previousReleaseTag(cwd, version);
  if (!previous) return null;
  const repository = repositoryName(pkg);
  const log = git(cwd, ['log', '--reverse', '--no-merges', '--format=%s', `${previous}..HEAD`]);
  return renderNotes(log ? log.split(/\r?\n/) : [], repository, previous, version);
}

export function prepareRelease(cwd, input) {
  const { pkg, lock } = readManifests(cwd);
  const version = releaseVersion(pkg.version, input);
  if (git(cwd, ['tag', '--list', `v${version}`]))
    throw new Error(`Release tag already exists: v${version}.`);
  const notesRelative = `docs/release-notes/v${version}.md`;
  const notesPath = join(cwd, notesRelative);
  const hasNotes = existsSync(notesPath);
  const notes = hasNotes ? null : generateNotes(cwd, pkg, version);
  // Validate Git even when keeping an existing hand-written notes file.
  git(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (pkg.version !== version) {
    pkg.version = version;
    lock.version = version;
    lock.packages[''].version = version;
    writeFileSync(join(cwd, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(cwd, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  }
  if (notes !== null) {
    mkdirSync(join(cwd, 'docs/release-notes'), { recursive: true });
    writeFileSync(notesPath, notes, { flag: 'wx' });
  }
  return {
    version,
    message: hasNotes
      ? `Keeping existing notes: ${notesRelative}`
      : notes === null
        ? `First release: write ${notesRelative} by hand as a short feature overview.`
        : `Draft created: ${notesRelative}. Curate it before release.`,
  };
}
