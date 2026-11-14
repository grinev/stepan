import process from 'node:process';
import { generateNotes, readManifests } from './release.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  process.stdout.write('Usage: npm run release:notes:preview\n');
} else if (args.length !== 0) {
  process.stderr.write('Usage: npm run release:notes:preview\n');
  process.exitCode = 2;
} else {
  try {
    const { pkg } = readManifests(process.cwd());
    const notes = generateNotes(process.cwd(), pkg, pkg.version);
    process.stdout.write(
      notes ?? 'First release: write the release notes by hand as a short feature overview.\n',
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
