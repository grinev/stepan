import type { Step } from './flow.js';
import type { RunState } from './run.js';

type InstructionContext = Pick<RunState, 'id' | 'task' | 'outcomes'>;

export function startOutput(description: string | undefined, step: string): string {
  if (description === undefined || description.length === 0) return step;
  return `${description}${description.endsWith('\n') ? '' : '\n'}\n${step}`;
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
  const command = ['stepan next', context.id, ...flags].join(' ');
  const instruction = instructionText(step.instruction, context);
  return `Run: ${context.id}\nStep: ${id}\n\n${instruction}${instruction.endsWith('\n') ? '' : '\n'}\n${command}\n`;
}

export function runsOutput(runs: RunState[], all: boolean): string {
  if (runs.length === 0) return all ? 'No runs.\n' : 'No active runs.\n';
  const lines = runs.map((run) =>
    [run.id, run.flowName, run.task, run.step, run.finished ? 'finished' : 'active']
      .map((value) => JSON.stringify(value))
      .join('\t'),
  );
  return `ID\tFLOW\tTASK\tSTEP\tSTATUS\n${lines.join('\n')}\n`;
}
