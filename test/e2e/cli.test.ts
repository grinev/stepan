import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCli } from './run-cli.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('stepan binary', () => {
  it('prints the package version', () => {
    const result = runCli(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('exits with a usage error on an unknown command', () => {
    const result = runCli(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });
});
