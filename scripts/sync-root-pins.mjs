#!/usr/bin/env node
// Keeps the build-only root package.json's @revt-eng/* pins in lockstep with
// web-sdk/package.json — the authoritative pins the SDK actually builds against.
//
// WHY THIS EXISTS: the public repo's three build entrypoints (release-npm,
// deploy-pages, deploy-docs-vercel) each run `pnpm install` at the REPO ROOT
// first, and with node-linker=hoisted the root's @revt-eng/* versions hoist to
// the top-level node_modules and SHADOW the versions web-sdk pins. web-sdk is a
// MIRRORED path (overwritten from revturbine-sdk-internal on every release
// sync), but the root manifest is public-owned and hand-maintained — so its
// pins drift behind web-sdk. When they lag, web-sdk's source resolves the STALE
// hoisted schema and the build fails (e.g. TS2305 "no exported member
// RevTurbineConfig"). That silently froze public @revturbine/sdk at 0.2.16 for
// five releases (fixed in revt-eng/revturbine-sdk#14).
//
// web-sdk/package.json is the source of truth; this script derives the root
// pins from it so they can never drift again. Run it BEFORE the root install in
// every workflow that installs at the root. `--check` fails instead of writing
// (for local verification); default mode writes the fix.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPath = join(repoRoot, 'package.json');
const webSdkPath = join(repoRoot, 'web-sdk', 'package.json');

// The @revt-eng/* packages that must hoist consistently for web-sdk's source
// (which reaches into ../server-node → @revt-eng/core, and imports @revt-eng/
// schema types directly) to resolve at the repo root.
const PINNED = ['@revt-eng/core', '@revt-eng/schema', '@revt-eng/schema-external'];
const check = process.argv.includes('--check');

const webSdk = JSON.parse(readFileSync(webSdkPath, 'utf8'));
const root = JSON.parse(readFileSync(rootPath, 'utf8'));
const webDeps = { ...webSdk.dependencies, ...webSdk.devDependencies };

root.dependencies ??= {};
const changes = [];
for (const name of PINNED) {
  const want = webDeps[name];
  if (!want) {
    console.error(`error: ${name} not found in web-sdk/package.json — cannot sync root pins.`);
    process.exit(1);
  }
  const have = root.dependencies[name];
  if (have !== want) {
    changes.push(`  ${name}: ${have ?? '(absent)'} -> ${want}`);
    root.dependencies[name] = want;
  }
}

if (changes.length === 0) {
  console.log('root @revt-eng/* pins already match web-sdk — no change.');
  process.exit(0);
}

if (check) {
  console.error('root @revt-eng/* pins have drifted from web-sdk/package.json:');
  console.error(changes.join('\n'));
  console.error('run `node scripts/sync-root-pins.mjs` to fix.');
  process.exit(1);
}

writeFileSync(rootPath, JSON.stringify(root, null, 2) + '\n');
console.log('synced root @revt-eng/* pins from web-sdk:');
console.log(changes.join('\n'));
