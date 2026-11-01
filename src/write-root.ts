import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function writeRoot(
  cwd: string,
  packageRoot = fileURLToPath(new URL('..', import.meta.url)),
): string {
  const fromSources =
    existsSync(join(packageRoot, 'src', 'cli.ts')) &&
    existsSync(join(packageRoot, 'tsconfig.build.json'));
  return fromSources ? join(packageRoot, '.dev-data') : cwd;
}
