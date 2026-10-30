import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// e2e tests run the built CLI, so build once before the suite rather than test a stale dist/.
export default function setup(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
  });
}
