import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isAlias, isPair, isScalar, parseDocument, visit } from 'yaml';

export type OutcomeField =
  { type: 'string'; required?: boolean } | { type: 'enum'; values: string[]; required?: boolean };

export interface Transition {
  to: string;
  when?: Record<string, string>;
}

export interface Step {
  instruction: string;
  outcome: Record<string, OutcomeField>;
  transitions: Transition[];
}

export interface Flow {
  description?: string;
  start: string;
  steps: Record<string, Step>;
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where}: unknown key '${key}'`);
  }
}

function string(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where}: expected a string`);
  return value;
}

function name(value: string, where: string): void {
  if (!NAME.test(value)) throw new Error(`${where}: invalid name '${value}'`);
}

function outcome(value: unknown, where: string): Record<string, OutcomeField> {
  if (value === undefined || value === null) return {};
  return Object.fromEntries(
    Object.entries(record(value, where)).map(([id, raw]): [string, OutcomeField] => {
      name(id, where);
      const at = `${where}.${id}`;
      const field = record(raw, at);
      keys(field, ['type', 'values', 'required'], at);
      if (field.required !== undefined && typeof field.required !== 'boolean') {
        throw new Error(`${at}.required: expected a boolean`);
      }
      const required = field.required === undefined ? {} : { required: field.required };
      if (field.type === 'string') {
        if (Object.hasOwn(field, 'values')) throw new Error(`${at}.values: only valid for enum`);
        return [id, { type: 'string', ...required } satisfies OutcomeField];
      }
      if (field.type !== 'enum') throw new Error(`${at}.type: expected 'string' or 'enum'`);
      if (
        !Array.isArray(field.values) ||
        field.values.length === 0 ||
        !field.values.every((entry: unknown) => typeof entry === 'string' && entry.length > 0)
      ) {
        throw new Error(`${at}.values: expected non-empty strings in a non-empty array`);
      }
      return [id, { type: 'enum', values: field.values as string[], ...required }];
    }),
  );
}

function transitions(
  value: unknown,
  fields: Record<string, OutcomeField>,
  where: string,
): Transition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array`);
  return value.map((raw: unknown, index) => {
    const at = `${where}[${String(index)}]`;
    const entry = record(raw, at);
    keys(entry, ['to', 'when'], at);
    const to = string(entry.to, `${at}.to`);
    if (!Object.hasOwn(entry, 'when')) {
      if (index !== value.length - 1) throw new Error(`${at}: default transition must be last`);
      return { to };
    }
    const conditions = Object.entries(record(entry.when, `${at}.when`));
    const condition = conditions[0];
    if (conditions.length !== 1 || condition === undefined) {
      throw new Error(`${at}.when: expected exactly one outcome field`);
    }
    const [id, rawExpected] = condition;
    if (!Object.hasOwn(fields, id)) throw new Error(`${at}.when: unknown outcome field '${id}'`);
    const expected = string(rawExpected, `${at}.when.${id}`);
    const field = fields[id];
    if (
      (field?.required === true && expected.length === 0) ||
      (field?.type === 'enum' && !field.values.includes(expected))
    ) {
      throw new Error(`${at}.when.${id}: value does not fit its outcome field`);
    }
    return { to, when: Object.fromEntries([[id, expected]]) };
  });
}

/** Validates both a flow definition and the graph embedded in a run snapshot. */
export function validateFlow(value: unknown): Flow {
  const flow = record(value, 'flow');
  keys(flow, ['description', 'start', 'steps'], 'flow');
  const description = Object.hasOwn(flow, 'description')
    ? { description: string(flow.description, 'flow.description') }
    : {};
  const start = string(flow.start, 'flow.start');
  const rawSteps = record(flow.steps, 'flow.steps');
  if (Object.keys(rawSteps).length === 0) throw new Error('flow.steps: expected at least one step');
  const steps = Object.fromEntries(
    Object.entries(rawSteps).map(([id, raw]): [string, Step] => {
      name(id, 'flow.steps');
      const at = `steps.${id}`;
      const step = record(raw, at);
      keys(step, ['instruction', 'outcome', 'transitions'], at);
      const instruction = string(step.instruction, `${at}.instruction`);
      const fields = outcome(step.outcome, `${at}.outcome`);
      return [
        id,
        {
          instruction,
          outcome: fields,
          transitions: transitions(step.transitions, fields, `${at}.transitions`),
        },
      ];
    }),
  );
  if (!Object.hasOwn(steps, start)) throw new Error(`flow.start: unknown step '${start}'`);
  for (const [id, step] of Object.entries(steps)) {
    for (const transition of step.transitions) {
      if (!Object.hasOwn(steps, transition.to)) {
        throw new Error(`steps.${id}.transitions: unknown target '${transition.to}'`);
      }
    }
  }
  return { ...description, start, steps };
}

export function loadFlow(cwd: string, flowName: string): Flow {
  const base = resolve(cwd, '.stepan', 'flows');
  const directory = resolve(base, flowName);
  const path = relative(base, directory);
  if (
    !path ||
    isAbsolute(flowName) ||
    isAbsolute(path) ||
    path === '..' ||
    path.startsWith(`..${sep}`)
  ) {
    throw new Error(`Invalid flow name '${flowName}': expected a directory under .stepan/flows/`);
  }
  const yamlPath = resolve(directory, 'flow.yaml');
  const document = parseDocument(readFileSync(yamlPath, 'utf8'), { schema: 'core' });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem !== undefined) throw new Error(`${yamlPath}: ${problem.message}`);
  // Validate keys before toJS can coerce distinct YAML keys into the same object property.
  visit(document, {
    Map(_key, map, ancestors) {
      const at =
        ancestors
          .filter(isPair)
          .map(({ key }) => (isScalar(key) && typeof key.value === 'string' ? key.value : '?'))
          .join('.') || 'flow';
      const seen = new Set<string>();
      for (const pair of map.items) {
        const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
        if (!isScalar(key) || typeof key.value !== 'string') {
          const label = isScalar(key) ? JSON.stringify(key.value) : '<complex>';
          throw new Error(`${yamlPath}: ${at}: mapping key ${label} must be a string`);
        }
        if (seen.has(key.value)) {
          throw new Error(`${yamlPath}: ${at}: duplicate mapping key '${key.value}'`);
        }
        seen.add(key.value);
      }
    },
  });
  const parsed: unknown = document.toJS({ maxAliasCount: 100 });
  const flow = validateFlow(parsed);
  return {
    ...(flow.description === undefined ? {} : { description: flow.description }),
    start: flow.start,
    steps: Object.fromEntries(
      Object.entries(flow.steps).map(([id, step]): [string, Step] => {
        const file = resolve(directory, step.instruction);
        try {
          return [id, { ...step, instruction: readFileSync(file, 'utf8') }];
        } catch (error) {
          throw new Error(
            `steps.${id}.instruction (${file}): ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }),
    ),
  };
}
