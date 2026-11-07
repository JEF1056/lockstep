import { execSync } from 'node:child_process';
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
let version;
let sha;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--version' && args[i + 1]) {
    version = args[++i];
  } else if (args[i].startsWith('--version=')) {
    version = args[i].slice('--version='.length);
  } else if (args[i] === '--sha' && args[i + 1]) {
    sha = args[++i];
  } else if (args[i].startsWith('--sha=')) {
    sha = args[i].slice('--sha='.length);
  }
}

if (!version) {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  version = pkg.version || '1.0.0';
}

if (!sha) {
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    sha = 'unknown';
  }
}

const docsDir = join(process.cwd(), 'docs');
const zipPath = join(docsDir, 'lockstep.zip');

if (!existsSync(docsDir)) {
  mkdirSync(docsDir, { recursive: true });
}

if (existsSync(zipPath)) {
  rmSync(zipPath);
}

const stagingDir = mkdtempSync(join(os.tmpdir(), 'lockstep-pack-'));

try {
  // 1. Copy extension/ to staging dir
  cpSync(join(process.cwd(), 'extension'), stagingDir, { recursive: true });

  // 2. Stamp version & version_name into staged manifest.json
  const stagedManifestPath = join(stagingDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(stagedManifestPath, 'utf8'));
  manifest.version = version;
  manifest.version_name = `${version} (${sha})`;
  writeFileSync(stagedManifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // 3. Write version.json to staged root AND docs/version.json
  const versionData = {
    version,
    commit: sha,
    publishedAt: new Date().toISOString(),
    zipUrl: 'https://jef1056.github.io/lockstep/lockstep.zip'
  };
  const versionJsonContent = JSON.stringify(versionData, null, 2) + '\n';
  writeFileSync(join(stagingDir, 'version.json'), versionJsonContent);
  writeFileSync(join(docsDir, 'version.json'), versionJsonContent);

  // 4. Zip staged root into docs/lockstep.zip
  execSync(`zip -r -q -X "${zipPath}" . -x "*.DS_Store*" -x "__MACOSX*"`, {
    cwd: stagingDir,
    stdio: 'inherit'
  });

  // 5. Verify root manifest.json + version.json via unzip -l
  const listOutput = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf8' });
  const lines = listOutput.split('\n');
  const files = lines
    .map(line => {
      const match = line.match(/^\s*\d+\s+[\d-]+\s+[\d:]+\s+(.+)$/);
      return match ? match[1].trim() : null;
    })
    .filter(Boolean);

  const hasRootManifest = files.includes('manifest.json');
  const hasRootVersion = files.includes('version.json');

  if (!hasRootManifest || !hasRootVersion) {
    throw new Error(
      `Archive verification failed: manifest.json (${hasRootManifest}), version.json (${hasRootVersion}) in ${zipPath}`
    );
  }

  console.log(`[pack] Successfully created docs/lockstep.zip (version ${version}, sha ${sha})`);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
