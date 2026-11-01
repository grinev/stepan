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

  it('prints start help without reading a flow or writing state', () => {
    expect(capture(['start', '--help'])).toEqual({
      code: 0,
      stdout: 'Usage: stepan start <flow> <task>\n',
      stderr: '',
    });
  });

  it.each([
    { args: ['start'] },
    { args: ['start', 'feature', ''] },
    { args: ['start', 'feature', 'task', 'extra'] },
    { args: ['start', '--help', '-h'] },
    { args: ['start', '--unknown'] },
  ])('rejects malformed start arguments (%#)', ({ args }) => {
    const result = capture(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: stepan start');
  });
});
