import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const sdkRoot = path.resolve(projectRoot, '..');
const entryFile = path.resolve(projectRoot, 'src', 'sandpack-sdk-entry.ts');
const outFile = path.resolve(projectRoot, 'src', 'sandpack', 'vendor', 'revturbine-sdk.local.js');

await mkdir(path.dirname(outFile), { recursive: true });

await build({
  entryPoints: [entryFile],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  banner: {
    js: 'import React from "react";',
  },
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  nodePaths: [path.resolve(projectRoot, 'node_modules')],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});

console.log(`Bundled local SDK to ${outFile}`);
