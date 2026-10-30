import { describe, expect, it } from 'vitest';
import { run } from './main.js';

function capture(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

describe('run', () => {
  it('prints usage when called without arguments', () => {
    const result = capture([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: stepan');
  });

  it('prints the package version', () => {
    const result = capture(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects an unknown command with a usage error', () => {
    const result = capture(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });
});
