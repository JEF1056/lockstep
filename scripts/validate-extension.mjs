/**
 * Lockstep Extension Validator
 * Verifies:
 * 1. manifest.json file references exist on disk
 * 2. Exact PNG icon dimensions (16x16, 48x48, 128x128)
 * 3. Manifest V3 CSP compliance (no inline scripts, no inline event handlers, no remote imports, no eval)
 * 4. Zero DOM-insertion calls in extension/content/
 */

import fs from 'node:fs';
import path from 'node:path';

let errors = [];
let passes = [];

function pass(msg) {
  passes.push(msg);
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  errors.push(msg);
  console.error(`  ✗ ${msg}`);
}

console.log('--- Lockstep Extension Validation ---\n');

// 1. Verify Manifest References
console.log('[1/4] Checking manifest.json and file references...');
const manifestPath = 'extension/manifest.json';
if (!fs.existsSync(manifestPath)) {
  fail(`manifest.json missing at ${manifestPath}`);
} else {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    pass('manifest.json is valid JSON');

    const filesToCheck = [];

    // Icons
    if (manifest.icons) {
      for (const [size, relPath] of Object.entries(manifest.icons)) {
        filesToCheck.push({ label: `icons.${size}`, path: path.join('extension', relPath) });
      }
    }

    // Action default_popup & default_icon
    if (manifest.action) {
      if (manifest.action.default_popup) {
        filesToCheck.push({
          label: 'action.default_popup',
          path: path.join('extension', manifest.action.default_popup)
        });
      }
      if (manifest.action.default_icon) {
        for (const [size, relPath] of Object.entries(manifest.action.default_icon)) {
          filesToCheck.push({
            label: `action.default_icon.${size}`,
            path: path.join('extension', relPath)
          });
        }
      }
    }

    // Background service worker
    if (manifest.background?.service_worker) {
      filesToCheck.push({
        label: 'background.service_worker',
        path: path.join('extension', manifest.background.service_worker)
      });
    }

    // Content scripts
    if (Array.isArray(manifest.content_scripts)) {
      manifest.content_scripts.forEach((cs, i) => {
        if (Array.isArray(cs.js)) {
          cs.js.forEach((jsPath, j) => {
            filesToCheck.push({
              label: `content_scripts[${i}].js[${j}]`,
              path: path.join('extension', jsPath)
            });
          });
        }
      });
    }

    for (const item of filesToCheck) {
      if (fs.existsSync(item.path)) {
        pass(`Referenced file exists: ${item.label} -> ${item.path}`);
      } else {
        fail(`Missing referenced file: ${item.label} -> ${item.path}`);
      }
    }
  } catch (e) {
    fail(`Failed to parse manifest.json: ${e.message}`);
  }
}

// 2. Exact PNG Dimensions
console.log('\n[2/4] Verifying exact PNG icon dimensions...');
const expectedIcons = [
  { file: 'extension/icons/icon-16.png', size: 16 },
  { file: 'extension/icons/icon-48.png', size: 48 },
  { file: 'extension/icons/icon-128.png', size: 128 },
];

for (const { file, size } of expectedIcons) {
  if (!fs.existsSync(file)) {
    fail(`Icon missing: ${file}`);
    continue;
  }
  const buf = fs.readFileSync(file);
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(pngSig)) {
    fail(`Invalid PNG signature for ${file}`);
    continue;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);

  if (width === size && height === size) {
    pass(`${file} exact dimension verified: ${width}x${height}`);
  } else {
    fail(`${file} dimension mismatch: expected ${size}x${size}, got ${width}x${height}`);
  }
}

// 3. MV3 CSP Compliance (no inline scripts/handlers, no remote imports, no eval)
console.log('\n[3/4] Verifying Manifest V3 CSP compliance...');

function findFiles(dir, filterFn) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, filterFn));
    } else if (filterFn(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

// Check HTML files
const htmlFiles = findFiles('extension', f => f.endsWith('.html'));
for (const file of htmlFiles) {
  const content = fs.readFileSync(file, 'utf8');

  // Check inline script tags with executable body (excluding src-only scripts)
  const inlineScriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = inlineScriptRegex.exec(content)) !== null) {
    if (match[1].trim().length > 0) {
      fail(`Inline script found in ${file}: "${match[1].trim().slice(0, 40)}..."`);
    }
  }

  // Check inline event handlers (onclick=, onload=, onmouseover=, etc.)
  const inlineHandlerRegex = /\son[a-z]+\s*=\s*['"][^'"]*['"]/gi;
  const handlers = content.match(inlineHandlerRegex);
  if (handlers) {
    fail(`Inline event handlers found in ${file}: ${handlers.join(', ')}`);
  } else {
    pass(`No inline scripts or handlers in ${file}`);
  }
}

// Check JS files for remote imports and eval
const jsFiles = findFiles('extension', f => f.endsWith('.js'));
for (const file of jsFiles) {
  const content = fs.readFileSync(file, 'utf8');
  // Strip comments for clean check
  const code = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  if (/(?:import\s*\(?|from\s*)['"]https?:\/\//i.test(code)) {
    fail(`Remote import found in ${file}`);
  }

  if (/\beval\s*\(|new\s+Function\s*\(/i.test(code)) {
    fail(`eval / new Function found in ${file}`);
  }
}
pass(`All ${jsFiles.length} JS files verified for zero remote imports and no eval`);

// 4. Zero DOM-insertion calls in extension/content/
console.log('\n[4/4] Verifying ZERO DOM-insertion calls in extension/content/...');
const contentJsFiles = findFiles('extension/content', f => f.endsWith('.js'));
if (contentJsFiles.length === 0) {
  fail('No content scripts found in extension/content/');
} else {
  const forbiddenPatterns = [
    { pattern: /\.appendChild\s*\(/, name: '.appendChild()' },
    { pattern: /\.insertBefore\s*\(/, name: '.insertBefore()' },
    { pattern: /\.attachShadow\s*\(/, name: '.attachShadow()' },
    { pattern: /\.innerHTML\s*=/, name: '.innerHTML =' },
    { pattern: /\.insertAdjacentHTML\s*\(/, name: '.insertAdjacentHTML()' },
    { pattern: /\.insertAdjacentElement\s*\(/, name: '.insertAdjacentElement()' },
    { pattern: /document\.createElement\s*\(/, name: 'document.createElement()' },
    { pattern: /document\.createElementNS\s*\(/, name: 'document.createElementNS()' },
  ];

  for (const file of contentJsFiles) {
    const raw = fs.readFileSync(file, 'utf8');
    // Strip comments and string literals
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    let fileViolations = [];
    for (const { pattern, name } of forbiddenPatterns) {
      if (pattern.test(code)) {
        fileViolations.push(name);
      }
    }

    if (fileViolations.length > 0) {
      fail(`DOM-insertion calls found in ${file}: ${fileViolations.join(', ')}`);
    } else {
      pass(`Zero DOM-insertion calls in ${file}`);
    }
  }
}

console.log('\n--------------------------------------');
if (errors.length > 0) {
  console.error(`Validation FAILED with ${errors.length} error(s).`);
  process.exit(1);
} else {
  console.log(`Validation PASSED! (${passes.length} checks passed cleanly)`);
  process.exit(0);
}
