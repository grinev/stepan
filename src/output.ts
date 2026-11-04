import type { Step } from './flow.js';
import type { RunState } from './run.js';

type InstructionContext = Pick<RunState, 'id' | 'task' | 'outcomes'>;

export function startOutput(description: string | undefined, step: string): string {
  if (description === undefined || description.length === 0) return step;
  return `${description}${description.endsWith('\n') ? '' : '\n'}\n${step}`;
}

function instructionText(text: string, context: InstructionContext): string {
  function substitute(placeholder: string): string {
    const key = placeholder.slice(2, -2);
    if (key === 'task') return context.task;
    const match = /^steps\.([A-Za-z][A-Za-z0-9_-]*)\.outcome\.([A-Za-z][A-Za-z0-9_-]*)$/.exec(key);
    if (match === null) return placeholder;
    const [, id = '', field = ''] = match;
    if (!Object.hasOwn(context.outcomes, id)) return '-';
    const outcome = context.outcomes[id];
    if (outcome === undefined || !Object.hasOwn(outcome, field)) return '-';
    return outcome[field] ?? '-';
  }

  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('{{', cursor);
    if (start === -1) return result + text.slice(cursor);
    result += text.slice(cursor, start);
    let depth = 1;
    let end = start + 2;
    let nested = false;
    const newline = text.indexOf('\n', end);
    const limit = newline === -1 ? text.length : newline;
    while (depth > 0) {
      const open = text.indexOf('{{', end);
      const close = text.indexOf('}}', end);
      if (close === -1 || close >= limit) break;
      if (open !== -1 && open < close) {
        depth++;
        nested = true;
        end = open + 2;
      } else {
        depth--;
        end = close + 2;
      }
    }
    if (depth > 0) {
      result += text.slice(start, limit);
      cursor = limit;
      continue;
    }
    const placeholder = text.slice(start, end);
    result += nested ? placeholder : substitute(placeholder);
    cursor = end;
  }
  return result;
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
