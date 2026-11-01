import type { Flow, Step } from './flow.js';

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

export function stepOutput(id: string, step: Step): string {
  const flags = Object.entries(step.outcome).map(([field, schema]) => {
    const value = schema.type === 'enum' ? `<${schema.values.join('|')}>` : '"<text>"';
    const flag = `--${field} ${value}`;
    return schema.required === true ? flag : `[${flag}]`;
  });
  const command = ['stepan next', id, ...flags].join(' ');
  return `${step.instruction}${step.instruction.endsWith('\n') ? '' : '\n'}\n${command}\n`;
}
