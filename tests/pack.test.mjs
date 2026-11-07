import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

describe('Pack Extension Script', () => {
  test('--version 1.0.77 --sha deadbee packages archive and leaves extension/manifest.json clean', () => {
    const manifestPath = join(process.cwd(), 'extension', 'manifest.json');
    const originalManifestContent = readFileSync(manifestPath, 'utf8');

    // Run pack script with test version and sha
    const output = execSync('node scripts/pack-extension.mjs --version 1.0.77 --sha deadbee', {
      encoding: 'utf8',
      cwd: process.cwd()
    });

    // 1. Verify extension/manifest.json remains untouched
    const currentManifestContent = readFileSync(manifestPath, 'utf8');
    assert.equal(currentManifestContent, originalManifestContent, 'extension/manifest.json must remain clean and unmodified');

    // 2. Verify docs/lockstep.zip exists
    const zipPath = join(process.cwd(), 'docs', 'lockstep.zip');
    assert.ok(existsSync(zipPath), 'docs/lockstep.zip should exist');

    // 3. Verify root contents of zip
    const listOutput = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf8' });
    const lines = listOutput.split('\n');
    const files = lines
      .map(line => {
        const match = line.match(/^\s*\d+\s+[\d-]+\s+[\d:]+\s+(.+)$/);
        return match ? match[1].trim() : null;
      })
      .filter(Boolean);

    assert.ok(files.includes('manifest.json'), 'archive must contain root manifest.json');
    assert.ok(files.includes('version.json'), 'archive must contain root version.json');

    // 4. Verify stamped values inside the zip's manifest.json
    const zippedManifestJson = execSync(`unzip -p "${zipPath}" manifest.json`, { encoding: 'utf8' });
    const zippedManifest = JSON.parse(zippedManifestJson);
    assert.equal(zippedManifest.version, '1.0.77');
    assert.equal(zippedManifest.version_name, '1.0.77 (deadbee)');

    // 5. Verify docs/version.json
    const docsVersionPath = join(process.cwd(), 'docs', 'version.json');
    assert.ok(existsSync(docsVersionPath), 'docs/version.json should exist');
    const docsVersion = JSON.parse(readFileSync(docsVersionPath, 'utf8'));
    assert.equal(docsVersion.version, '1.0.77');
    assert.equal(docsVersion.commit, 'deadbee');
    assert.equal(docsVersion.zipUrl, 'https://jef1056.github.io/lockstep/lockstep.zip');
    assert.ok(docsVersion.publishedAt, 'publishedAt must be present');
  });
});
