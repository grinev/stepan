import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFlow, validateFlow } from './flow.js';

function definition(step: unknown = { instruction: 'first.md' }) {
  return { start: 'first', steps: { first: step } };
}

describe('validateFlow', () => {
  it.each(['', 'First line\nSecond line\n'])('preserves description (%#)', (description) => {
    expect(validateFlow({ ...definition(), description }).description).toBe(description);
    expect(Object.hasOwn(validateFlow(definition()), 'description')).toBe(false);
  });

  it.each([null, true, 42, [], {}, undefined])(
    'rejects non-string description (%#)',
    (description) => {
      expect(() => validateFlow({ ...definition(), description })).toThrow('flow.description');
    },
  );

  it('normalizes optional fields and accepts empty instruction snapshots', () => {
    expect(validateFlow(definition({ instruction: '', outcome: null, transitions: [] }))).toEqual({
      start: 'first',
      steps: { first: { instruction: '', outcome: {}, transitions: [] } },
    });
    expect(validateFlow(definition()).steps.first?.outcome).toEqual({});
  });

  it('accepts cycles, optional fields, enums and an ordered default', () => {
    const flow = validateFlow(
      definition({
        instruction: 'first.md',
        outcome: {
          verdict: { type: 'enum', values: ['pass', 'fail'], required: true },
          note: { type: 'string', required: false },
        },
        transitions: [{ when: { verdict: 'fail' }, to: 'first' }, { to: 'first' }],
      }),
    );
    expect(flow.steps.first?.transitions).toEqual([
      { when: { verdict: 'fail' }, to: 'first' },
      { to: 'first' },
    ]);
  });

  it('treats prototype property names as ordinary names, not inherited steps or fields', () => {
    expect(() =>
      validateFlow({ start: 'constructor', steps: { first: { instruction: '' } } }),
    ).toThrow('unknown step');
    expect(() =>
      validateFlow(definition({ instruction: '', transitions: [{ to: 'toString' }] })),
    ).toThrow('unknown target');
    expect(() =>
      validateFlow(
        definition({ instruction: '', transitions: [{ to: 'first', when: { constructor: 'x' } }] }),
      ),
    ).toThrow('unknown outcome field');
    expect(
      validateFlow({
        start: 'constructor',
        steps: { constructor: { instruction: '', outcome: { constructor: { type: 'string' } } } },
      }).start,
    ).toBe('constructor');
  });

  it.each([
    [null, 'flow'],
    [[], 'flow'],
    [{ ...definition(), extra: true }, "unknown key 'extra'"],
    [{ steps: { first: { instruction: '' } } }, 'flow.start'],
    [{ start: 'first', steps: {} }, 'at least one'],
    [{ start: 'missing', steps: { first: { instruction: '' } } }, 'unknown step'],
    [{ start: '1bad', steps: { '1bad': { instruction: '' } } }, 'invalid name'],
    [definition(null), 'steps.first'],
    [definition({ instruction: 2 }), 'instruction'],
    [definition({ instruction: '', extra: true }), "unknown key 'extra'"],
    [definition({ instruction: '', outcome: [] }), 'outcome'],
    [definition({ instruction: '', outcome: { 'bad.name': { type: 'string' } } }), 'invalid name'],
    [definition({ instruction: '', outcome: { value: null } }), 'outcome.value'],
    [definition({ instruction: '', outcome: { value: { type: 'number' } } }), '.type'],
    [
      definition({ instruction: '', outcome: { value: { type: 'string', extra: true } } }),
      'unknown key',
    ],
    [
      definition({ instruction: '', outcome: { value: { type: 'string', values: [] } } }),
      'only valid for enum',
    ],
    [
      definition({ instruction: '', outcome: { value: { type: 'string', required: null } } }),
      '.required',
    ],
    [definition({ instruction: '', outcome: { value: { type: 'enum' } } }), '.values'],
    [definition({ instruction: '', outcome: { value: { type: 'enum', values: [] } } }), '.values'],
    [
      definition({ instruction: '', outcome: { value: { type: 'enum', values: [''] } } }),
      '.values',
    ],
    [
      definition({ instruction: '', outcome: { value: { type: 'enum', values: [true] } } }),
      '.values',
    ],
    [definition({ instruction: '', transitions: null }), '.transitions'],
    [definition({ instruction: '', transitions: [null] }), '.transitions[0]'],
    [definition({ instruction: '', transitions: [{ to: 'missing' }] }), 'unknown target'],
    [definition({ instruction: '', transitions: [{ when: {} }] }), '.to'],
    [definition({ instruction: '', transitions: [{ to: 'first', extra: true }] }), 'unknown key'],
    [
      definition({ instruction: '', transitions: [{ to: 'first' }, { to: 'first' }] }),
      'default transition must be last',
    ],
    [definition({ instruction: '', transitions: [{ to: 'first', when: {} }] }), 'exactly one'],
    [
      definition({ instruction: '', transitions: [{ to: 'first', when: { a: 'x', b: 'y' } }] }),
      'exactly one',
    ],
    [definition({ instruction: '', transitions: [{ to: 'first', when: null }] }), '.when'],
    [
      definition({ instruction: '', transitions: [{ to: 'first', when: { missing: 'x' } }] }),
      'unknown outcome field',
    ],
    [
      definition({
        instruction: '',
        outcome: { v: { type: 'string' } },
        transitions: [{ to: 'first', when: { v: 1 } }],
      }),
      '.when.v',
    ],
    [
      definition({
        instruction: '',
        outcome: { v: { type: 'string', required: true } },
        transitions: [{ to: 'first', when: { v: '' } }],
      }),
      'does not fit',
    ],
    [
      definition({
        instruction: '',
        outcome: { v: { type: 'enum', values: ['ok'] } },
        transitions: [{ to: 'first', when: { v: 'bad' } }],
      }),
      'does not fit',
    ],
  ])('rejects invalid definitions with context (%#)', (value, message) => {
    expect(() => validateFlow(value)).toThrow(message);
  });

  it('allows an empty conditional value for an optional string', () => {
    expect(
      validateFlow(
        definition({
          instruction: '',
          outcome: { v: { type: 'string' } },
          transitions: [{ to: 'first', when: { v: '' } }],
        }),
      ).steps.first?.transitions[0]?.when,
    ).toEqual({ v: '' });
  });
});

describe('loadFlow', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function fixture(yaml: string): string {
    const cwd = mkdtempSync(join(tmpdir(), 'stepan-flow-'));
    directories.push(cwd);
    const flow = join(cwd, '.stepan', 'flows', 'example');
    mkdirSync(flow, { recursive: true });
    writeFileSync(join(flow, 'flow.yaml'), yaml);
    return cwd;
  }

  it('loads all instruction texts and keeps unresolved placeholders', () => {
    const cwd = fixture(
      'description: |\n  Context {{task}}\n  Second line\nstart: first\nsteps:\n  first:\n    instruction: first.md\n  last:\n    instruction: last.md\n',
    );
    writeFileSync(join(cwd, '.stepan/flows/example/first.md'), 'Task {{task}}');
    writeFileSync(join(cwd, '.stepan/flows/example/last.md'), 'Последний шаг');
    expect(loadFlow(cwd, 'example').steps.last?.instruction).toBe('Последний шаг');
    expect(loadFlow(cwd, 'example').steps.first?.instruction).toBe('Task {{task}}');
    expect(loadFlow(cwd, 'example').description).toBe('Context {{task}}\nSecond line\n');
  });

  it.each([
    ['', undefined],
    ['description: ""\n', ''],
  ])('preserves absent and empty descriptions on load (%#)', (prefix, description) => {
    const cwd = fixture(`${prefix}start: first\nsteps:\n  first: {instruction: first.md}\n`);
    writeFileSync(join(cwd, '.stepan/flows/example/first.md'), 'Instruction.');
    const flow = loadFlow(cwd, 'example');
    expect(Object.hasOwn(flow, 'description')).toBe(description !== undefined);
    expect(flow.description).toBe(description);
  });

  it.each(['../outside', '/absolute', '.', ''])(
    'rejects flow names outside .stepan/flows: %s',
    (flow) => {
      expect(() => loadFlow('project', flow)).toThrow(
        `Invalid flow name '${flow}': expected a directory under .stepan/flows/`,
      );
    },
  );

  it('does not fall back to the root flows directory', () => {
    const cwd = fixture('start: first\nsteps:\n  first: {instruction: first.md}\n');
    writeFileSync(join(cwd, '.stepan/flows/example/first.md'), 'Old instruction.');
    renameSync(join(cwd, '.stepan/flows'), join(cwd, 'flows'));
    expect(() => loadFlow(cwd, 'example')).toThrow(join(cwd, '.stepan/flows/example/flow.yaml'));
  });

  it('uses .stepan/flows even when a root flows directory exists', () => {
    const yaml = 'start: first\nsteps:\n  first: {instruction: first.md}\n';
    const cwd = fixture(yaml);
    writeFileSync(join(cwd, '.stepan/flows/example/first.md'), 'Project instruction.');
    const old = join(cwd, 'flows/example');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'flow.yaml'), yaml);
    writeFileSync(join(old, 'first.md'), 'Old instruction.');
    expect(loadFlow(cwd, 'example').steps.first?.instruction).toBe('Project instruction.');
  });

  it.each([
    'start: [',
    'start: a\nstart: b\nsteps: {}',
    'start: !custom first\nsteps: {}',
    'start: a\n---\nstart: b',
  ])('rejects malformed YAML, duplicate keys and unknown tags (%#)', (yaml) => {
    const cwd = fixture(yaml);
    expect(() => loadFlow(cwd, 'example')).toThrow('flow.yaml');
  });

  it('names the step and path when an instruction cannot be read', () => {
    const cwd = fixture('start: first\nsteps:\n  first:\n    instruction: missing.md\n');
    expect(() => loadFlow(cwd, 'example')).toThrow('steps.first.instruction');
  });

  it.each([
    '      true: {type: number, required: true}\n      "true": {type: string}',
    '      1: {type: number}\n      "1": {type: string}',
    '      ? [a, b]\n      : {type: string}',
    '      &field value: {type: number}\n      ? *field\n      : {type: string}',
  ])('rejects non-string or aliased duplicate mapping keys before conversion (%#)', (fields) => {
    const cwd = fixture(
      `start: first\nsteps:\n  first:\n    instruction: first.md\n    outcome:\n${fields}\n`,
    );
    writeFileSync(join(cwd, '.stepan/flows/example/first.md'), 'Instruction.');
    expect(() => loadFlow(cwd, 'example')).toThrow(/key/);
  });

  it('supports valid string aliases as mapping keys without coercion', () => {
    const cwd = fixture('start: &id first\nsteps:\n  ? *id\n  : {instruction: first.md}\n');
    writeFileSync(join(cwd, '.stepan/flows/example/first.md'), 'Instruction.');
    expect(loadFlow(cwd, 'example').steps.first?.instruction).toBe('Instruction.');
  });
});
