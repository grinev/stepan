import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunState } from '../../src/run.js';
import { createCli, runCli, runId, runPath } from './run-cli.js';

describe.each(['installed', 'sources'] as const)('output labels in %s mode', (layout) => {
  it.each([
    ['', '\n'],
    ['Выполни {{task}}.', 'Выполни Задача.\n'],
    ['Выполни {{task}}.\n', 'Выполни Задача.\n'],
    ['Выполни {{task}}.\nВторая строка.\n\n', 'Выполни Задача.\nВторая строка.\n\n'],
  ])('labels author content without changing it (%#)', (instruction, printed) => {
    const cli = createCli(layout);
    const description = 'Описание {{task}}.\nВторая строка.\n\n';
    const flow = `description: ${JSON.stringify(description)}
start: first
steps:
  first:
    instruction: first.md
    outcome:
      summary: {type: string, required: true}
    transitions:
      - to: finish
  finish:
    instruction: finish.md
`;
    const directory = join(cli.cwd, '.stepan/flows/feature');
    mkdirSync(directory, { recursive: true });
    const files = { 'flow.yaml': flow, 'first.md': instruction, 'finish.md': 'Заверши {{task}}.' };
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(directory, name), content);

    const started = runCli(['start', 'feature', 'Задача'], cli);
    const id = runId(started);
    const expected = `Run: ${id}\nStep: first\n\nInstructions:\n${printed}\nAfter completing this step, run:\nstepan next ${id} --summary "<text>"\n`;
    expect(started).toMatchObject({
      code: 0,
      stderr: '',
      stdout: `Flow description:\n${description}\n${expected}`,
    });
    const initialState = readFileSync(runPath(cli, id), 'utf8');
    expect(runCli(['current', id], cli)).toMatchObject({ code: 0, stderr: '', stdout: expected });
    expect(readFileSync(runPath(cli, id), 'utf8')).toBe(initialState);

    const final = `Run: ${id}\nStep: finish\n\nInstructions:\nЗаверши Задача.\n\nAfter completing this step, run:\nstepan next ${id}\n`;
    expect(runCli(['next', id, '--summary', 'Готово'], cli)).toMatchObject({
      code: 0,
      stderr: '',
      stdout: final,
    });
    expect(runCli(['current', id], cli)).toMatchObject({ code: 0, stderr: '', stdout: final });
    expect(runCli(['next', id], cli)).toMatchObject({
      code: 0,
      stderr: '',
      stdout: `Run ${id} is finished.\n`,
    });
    expect(runCli(['current', id], cli)).toMatchObject({
      code: 0,
      stderr: '',
      stdout: `Run ${id} is finished.\n`,
    });

    const state = JSON.parse(readFileSync(runPath(cli, id), 'utf8')) as RunState;
    expect({
      ...state,
      events: state.events.map(({ at, ...event }) => {
        expect(at).toEqual(expect.any(String));
        return event;
      }),
    }).toEqual({
      version: 2,
      id,
      flowName: 'feature',
      task: 'Задача',
      events: [
        { type: 'started', step: 'first' },
        { type: 'transitioned', from: 'first', to: 'finish', outcome: { summary: 'Готово' } },
        { type: 'finished', step: 'finish', outcome: {} },
      ],
    });
    for (const [name, content] of Object.entries(files))
      expect(readFileSync(join(directory, name), 'utf8')).toBe(content);
  });
});
