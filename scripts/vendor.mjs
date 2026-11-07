import * as esbuild from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// 1. Bundle trystero peer-to-peer library for extension
const outPath = 'extension/vendor/trystero-nostr.min.js';
await mkdir(dirname(outPath), { recursive: true });

await esbuild.build({
  stdin: {
    contents: "export { joinRoom, selfId } from 'trystero/nostr';",
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['chrome116'],
  outfile: outPath,
});

console.log(`[vendor] Successfully bundled ${outPath}`);

// 2. Copy WOFF2 fonts to extension/fonts/ and docs/fonts/
const fontFiles = [
  {
    src: 'node_modules/@fontsource/wix-madefor-display/files/wix-madefor-display-latin-600-normal.woff2',
    name: 'wix-madefor-display-600.woff2',
  },
  {
    src: 'node_modules/@fontsource/wix-madefor-display/files/wix-madefor-display-latin-700-normal.woff2',
    name: 'wix-madefor-display-700.woff2',
  },
  {
    src: 'node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2',
    name: 'instrument-sans-400.woff2',
  },
  {
    src: 'node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-500-normal.woff2',
    name: 'instrument-sans-500.woff2',
  },
  {
    src: 'node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2',
    name: 'instrument-sans-600.woff2',
  },
  {
    src: 'node_modules/@fontsource/source-code-pro/files/source-code-pro-latin-500-normal.woff2',
    name: 'source-code-pro-500.woff2',
  },
  {
    src: 'node_modules/@fontsource/source-code-pro/files/source-code-pro-latin-600-normal.woff2',
    name: 'source-code-pro-600.woff2',
  },
];

const destDirs = ['extension/fonts', 'docs/fonts'];
for (const dir of destDirs) {
  await mkdir(dir, { recursive: true });
}

for (const { src, name } of fontFiles) {
  for (const dir of destDirs) {
    const target = join(dir, name);
    await copyFile(src, target);
  }
}

console.log(`[vendor] Copied ${fontFiles.length} fonts to ${destDirs.join(' and ')}:`);
for (const f of fontFiles) {
  console.log(`  - ${f.name}`);
}
