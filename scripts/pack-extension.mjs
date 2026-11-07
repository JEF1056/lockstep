import { execSync } from 'node:child_process';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const docsDir = join(process.cwd(), 'docs');
const zipPath = join(docsDir, 'lockstep.zip');

if (!existsSync(docsDir)) {
  mkdirSync(docsDir, { recursive: true });
}

if (existsSync(zipPath)) {
  rmSync(zipPath);
}

// Package extension contents at archive root so manifest.json is at the top level
execSync('zip -r -q -X ../docs/lockstep.zip . -x "*.DS_Store*" -x "__MACOSX*"', {
  cwd: join(process.cwd(), 'extension'),
  stdio: 'inherit',
});

console.log(`[pack] Successfully created docs/lockstep.zip`);
