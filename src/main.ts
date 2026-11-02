import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadFlow } from './flow.js';
import { graphOverview, stepOutput } from './output.js';
import { loadRun, saveStart } from './run-store.js';
import { writeRoot } from './write-root.js';

export interface Output {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage: stepan <command>

Commands:
  start <flow> <task>  validate a flow and start a run
  current              print the current step from the snapshot

Options:
  -v, --version  print the version
  -h, --help     print this help
`;

const START_USAGE = 'Usage: stepan start <flow> <task>\n';
const CURRENT_USAGE = 'Usage: stepan current\n';

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

function readVersion(): string {
  // ../package.json resolves to the package root both from src/ and from dist/.
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version: string };
  return pkg.version;
}
