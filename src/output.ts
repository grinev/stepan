import type { Flow, Step } from './flow.js';
import type { RunState } from './run.js';

type InstructionContext = Pick<RunState, 'task' | 'outcomes'>;

export function graphOverview(flow: Flow): string {
  return Object.entries(flow.steps)
    .map(([id, step]) => {
      if (step.transitions.length === 0) return `${id} (final)`;
      const edges = step.transitions.map(({ to, when }) => {
        const condition =
          when === undefined
            ? ''
            : `${Object.entries(when)
                .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
                .join('')} -> `;
        return `${condition}${to}`;
      });
      return `${id} -> ${edges.join(', ')}`;
    })
    .join('\n');
}

function instructionText(text: string, context: InstructionContext): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (placeholder: string, key: string) => {
    if (key === 'task') return context.task;
    const match = /^steps\.([A-Za-z][A-Za-z0-9_-]*)\.outcome\.([A-Za-z][A-Za-z0-9_-]*)$/.exec(key);
    const [, id, field] = match ?? [];
    if (id === undefined || field === undefined || !Object.hasOwn(context.outcomes, id)) {
      return placeholder;
    }
    const outcome = context.outcomes[id];
    if (outcome === undefined || !Object.hasOwn(outcome, field)) return placeholder;
    return outcome[field] ?? placeholder;
  });
}

export function stepOutput(id: string, step: Step, context: InstructionContext): string {
  const flags = Object.entries(step.outcome).map(([field, schema]) => {
    const value = schema.type === 'enum' ? `<${schema.values.join('|')}>` : '"<text>"';
    const flag = `--${field} ${value}`;
    return schema.required === true ? flag : `[${flag}]`;
  });
  const command = ['stepan next', id, ...flags].join(' ');
  const instruction = instructionText(step.instruction, context);
  return `${instruction}${instruction.endsWith('\n') ? '' : '\n'}\n${command}\n`;
}
