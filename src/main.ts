import { readFileSync } from 'node:fs';

export interface Output {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage: stepan <command>

Options:
  -v, --version  print the version
  -h, --help     print this help
`;

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

  out.stderr(`stepan: unknown command '${first}'\n\n${USAGE}`);
  return 2;
}

function readVersion(): string {
  // ../package.json resolves to the package root both from src/ and from dist/.
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version: string };
  return pkg.version;
}
