import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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
