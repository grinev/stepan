import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeRoot } from './write-root.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('uses cwd unless both source markers exist, then uses the package dev root', () => {
  const root = mkdtempSync(join(tmpdir(), 'stepan-root-'));
  directories.push(root);
  const cwd = join(root, 'другой проект');
  expect(writeRoot(cwd, root)).toBe(cwd);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/cli.ts'), '');
  expect(writeRoot(cwd, root)).toBe(cwd);
  writeFileSync(join(root, 'tsconfig.build.json'), '{}');
  expect(writeRoot(cwd, root)).toBe(join(root, '.dev-data'));
  rmSync(join(root, 'src/cli.ts'));
  expect(writeRoot(cwd, root)).toBe(cwd);
});
