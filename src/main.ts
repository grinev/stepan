import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadFlow, type Flow, type Step } from './flow.js';
import { runsOutput, startOutput, stepOutput } from './output.js';
import { removeRun, listRuns, loadRun, saveStart, updateRun, validateRunId } from './run-store.js';
import { advanceRun, currentStep, runView, type RunState } from './run.js';
import { writeRoot } from './write-root.js';

export interface Output {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage: stepan <command>

Commands:
  start <flow> <task>  validate a flow and start a run
  current <run-id>      print the current step from project files
  next <run-id> [--<field> <value>...]  report an outcome and advance the run
  rm <run-id>           delete a run
  runs [--all]          list active runs, or include finished runs

Options:
  -v, --version  print the version
  -h, --help     print this help
`;

const START_USAGE = 'Usage: stepan start <flow> <task>\n';
const CURRENT_USAGE = 'Usage: stepan current <run-id>\n';
const NEXT_USAGE = 'Usage: stepan next <run-id> [--<field> <value>...]\n';
const RM_USAGE = 'Usage: stepan rm <run-id>\n';
const RUNS_USAGE = 'Usage: stepan runs [--all]\n';

class UsageError extends Error {}

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
  if (first === 'rm') return current(argv.slice(1), out, true);
  if (first === 'runs') return runs(argv.slice(1), out);

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
    const run = saveStart(writeRoot(cwd), flow, flowName, task);
    const view = runView(run);
    out.stdout(startOutput(flow.description, stepOutput(view.step, currentStep(run, flow), view)));
    return 0;
  } catch (error) {
    out.stderr(`stepan: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function current(argv: readonly string[], out: Output, remove = false): number {
  const usage = remove ? RM_USAGE : CURRENT_USAGE;
  let id: string;
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
    if (args.values.help === true && args.positionals.length === 0) {
      out.stdout(usage);
      return 0;
    }
    if (args.values.help === true || args.positionals.length !== 1)
      throw new Error('Expected a run ID');
    id = args.positionals[0] ?? '';
    validateRunId(id);
  } catch (error) {
    out.stderr(`stepan: ${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return 2;
  }
  try {
    const root = writeRoot(process.cwd());
    if (remove) {
      removeRun(root, id);
      out.stdout(`Run ${id} deleted.\n`);
      return 0;
    }
    const run = loadRun(root, id);
    const view = runView(run);
    if (view.finished) {
      out.stdout(`Run ${id} is finished.\n`);
      return 0;
    }
    const flow = runFlow(run);
    out.stdout(stepOutput(view.step, currentStep(run, flow), view));
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
  try {
    validateRunId(id ?? '');
  } catch (error) {
    out.stderr(`stepan: ${error instanceof Error ? error.message : String(error)}\n${NEXT_USAGE}`);
    return 2;
  }
  if (id === undefined) return 2;
  try {
    const root = writeRoot(process.cwd());
    let response = '';
    updateRun(root, id, (loaded) => {
      if (runView(loaded).finished) throw new Error(`Run ${id} is finished.`);
      const flow = runFlow(loaded);
      const step = currentStep(loaded, flow);
      let outcome: Record<string, string>;
      try {
        outcome = parseNextOutcome(argv.slice(1), step);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
      const updated = advanceRun(loaded, flow, outcome);
      const view = runView(updated);
      response = view.finished
        ? `Run ${id} is finished.\n`
        : stepOutput(view.step, currentStep(updated, flow), view);
      return updated;
    });
    out.stdout(response);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      out.stderr(`stepan: ${error.message}\n${NEXT_USAGE}`);
      return 2;
    }
    out.stderr(`stepan: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function runFlow(run: RunState): Flow {
  try {
    return loadFlow(process.cwd(), run.flowName);
  } catch (error) {
    throw new Error(
      `Run ${run.id}, flow '${run.flowName}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function runs(argv: readonly string[], out: Output): number {
  let all: boolean;
  try {
    const args = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: { help: { type: 'boolean', short: 'h' }, all: { type: 'boolean' } },
      tokens: true,
    });
    const names = args.tokens.filter((token) => token.kind === 'option').map((token) => token.name);
    if (new Set(names).size !== names.length) throw new Error('Repeated option');
    if (args.values.help === true) {
      if (args.values.all === true) throw new Error('Help must stand alone');
      out.stdout(RUNS_USAGE);
      return 0;
    }
    all = args.values.all === true;
  } catch (error) {
    out.stderr(`stepan: ${error instanceof Error ? error.message : String(error)}\n${RUNS_USAGE}`);
    return 2;
  }
  try {
    out.stdout(runsOutput(listRuns(writeRoot(process.cwd()), all), all));
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
