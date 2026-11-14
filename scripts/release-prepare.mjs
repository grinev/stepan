import process from 'node:process';
import { prepareRelease } from './release.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  process.stdout.write('Usage: npm run release:prepare -- <X.Y.Z|patch|minor|major>\n');
} else if (args.length !== 1 || args[0].startsWith('-')) {
  process.stderr.write('Usage: npm run release:prepare -- <X.Y.Z|patch|minor|major>\n');
  process.exitCode = 2;
} else {
  try {
    const result = prepareRelease(process.cwd(), args[0]);
    process.stdout.write(`Prepared v${result.version} locally.\n${result.message}\n`);
    process.stdout.write('Nothing committed, tagged or published. See docs/releasing.md.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
