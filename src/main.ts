import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadFlow, type Step } from './flow.js';
import { graphOverview, stepOutput } from './output.js';
import { loadRun, saveNext, saveStart } from './run-store.js';
import { currentStep } from './run.js';
import { writeRoot } from './write-root.js';

export interface Output {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage: stepan <command>

Commands:
  start <flow> <task>  validate a flow and start a run
  current              print the current step from the snapshot
  next <step> [--<field> <value>...]  report an outcome and advance the run

Options:
  -v, --version  print the version
  -h, --help     print this help
`;

const START_USAGE = 'Usage: stepan start <flow> <task>\n';
const CURRENT_USAGE = 'Usage: stepan current\n';
const NEXT_USAGE = 'Usage: stepan next <step> [--<field> <value>...]\n';

/** Runs one CLI invocation and returns the process exit code. */
export function run(argv: readonly string[], out: Output): number {
  const [first] = argv;

  if (first === undefined || first === '-h' || first === '--help') {
    out.stdout(USAGE);
    return 0;
  }

  if (first === '-v' || first === '--version') {
    out.stdout(`${readVersion()}\n`);
    return 0;
  }

  if (first === 'start') return start(argv.slice(1), out);
  if (first === 'current') return current(argv.slice(1), out);
  if (first === 'next') return next(argv.slice(1), out);

  out.stderr(`stepan: unknown command '${first}'\n\n${USAGE}`);
  return 2;
}

function start(argv: readonly string[], out: Output): number {
  let positionals: string[];
  try {
    const args = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' } },
      tokens: true,
    });
    if (args.tokens.filter((token) => token.kind === 'option').length > 1) {
      throw new Error('Repeated option');
    }
    if (args.values.help === true) {
      out.stdout(START_USAGE);
      return 0;
    }
    positionals = args.positionals;
    if (positionals.length !== 2 || positionals.some((value) => value.length === 0)) {
      throw new Error('Expected a flow and a non-empty task');
    }
  } catch (error) {
    out.stderr(`stepan: ${error instanceof Error ? error.message : String(error)}\n${START_USAGE}`);
    return 2;
  }
  try {
    const [flowName = '', task = ''] = positionals;
    const cwd = process.cwd();
    const flow = loadFlow(cwd, flowName);
    const run = saveStart(writeRoot(cwd), flow, task);
    const step = flow.steps[run.step];
    if (step === undefined) throw new Error(`Unknown start step '${run.step}'`);
    out.stdout(`${graphOverview(flow)}\n\n${stepOutput(run.step, step)}`);
    return 0;
  } catch (error) {
    out.stderr(`stepan: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function current(argv: readonly string[], out: Output): number {
  try {
    const args = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: { help: { type: 'boolean', short: 'h' } },
      tokens: true,
    });
    if (args.tokens.filter((token) => token.kind === 'option').length > 1) {
      throw new Error('Repeated option');
    }
    if (args.values.help === true) {
      out.stdout(CURRENT_USAGE);
      return 0;
    }
  } catch (error) {
    out.stderr(
      `stepan: ${error instanceof Error ? error.message : String(error)}\n${CURRENT_USAGE}`,
    );
    return 2;
  }
  try {
    const run = loadRun(writeRoot(process.cwd()));
    if (run.finished) {
      out.stdout('Run is finished.\n');
      return 0;
    }
    const step = run.flow.steps[run.step];
    if (step === undefined) throw new Error(`Unknown current step '${run.step}'`);
    out.stdout(stepOutput(run.step, step));
    return 0;
  } catch (error) {
    out.stderr(`stepan: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function next(argv: readonly string[], out: Output): number {
  const [id] = argv;
  if (argv.length === 1 && (id === '--help' || id === '-h')) {
    out.stdout(NEXT_USAGE);
    return 0;
  }
  if (id === undefined || id === '' || id.startsWith('-')) {
    out.stderr(`stepan: Expected a step before outcome flags\n${NEXT_USAGE}`);
    return 2;
  }
  try {
    const root = writeRoot(process.cwd());
    const step = currentStep(loadRun(root), id);
    let outcome: Record<string, string>;
    try {
      outcome = parseNextOutcome(argv.slice(1), step);
    } catch (error) {
      out.stderr(
        `stepan: ${error instanceof Error ? error.message : String(error)}\n${NEXT_USAGE}`,
      );
      return 2;
    }
    const run = saveNext(root, id, outcome);
    if (run.finished) out.stdout('Run is finished.\n');
    else out.stdout(stepOutput(run.step, currentStep(run, run.step)));
    return 0;
  } catch (error) {
    out.stderr(`stepan: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseNextOutcome(argv: readonly string[], step: Step): Record<string, string> {
  const args = parseArgs({
    args: [...argv],
    allowPositionals: false,
    options: Object.fromEntries(
      Object.keys(step.outcome).map((field) => [field, { type: 'string' as const }]),
    ),
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of args.tokens) {
    if (token.kind !== 'option') continue;
    if (!token.rawName.startsWith('--')) throw new Error(`Expected a long flag: ${token.rawName}`);
    if (seen.has(token.name)) throw new Error(`Repeated option '--${token.name}'`);
    seen.add(token.name);
  }
  return Object.fromEntries(
    Object.entries(args.values).map(([field, value]) => {
      if (typeof value !== 'string') throw new Error(`Expected a value for '--${field}'`);
      return [field, value];
    }),
  );
}

function readVersion(): string {
  // ../package.json resolves to the package root both from src/ and from dist/.
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version: string };
  return pkg.version;
}
