#!/usr/bin/env node
// Fails fast when pages-build/node_modules is physically incomplete.
//
// Why this exists: pnpm decides whether an install is needed by consulting
// `node_modules/.pnpm-workspace-state-v1.json`, NOT by looking at the tree. If
// that state file says "complete" but packages are physically missing (an
// interrupted install, a half-finished `rm -rf`, an editor/AV process holding
// files open), every repair route pnpm offers short-circuits — `pnpm install`,
// `--frozen-lockfile`, and even `--force` all print "Already up to date" in
// ~300ms and leave the tree broken. `verifyDepsBeforeRun` (default: install)
// is blind to it for the same reason; it only catches lockfile drift.
//
// The build then dies on whichever transitive import happens to resolve first
// — e.g. `Cannot find package 'remark-gfm' imported from @astrojs/
// markdown-remark`, which reads like an upstream bug rather than a local
// tree problem. This check names the real cause and the one command that
// actually repairs it.
//
// Wired as `predev` / `prebuild` (pages-build sets `enablePrePostScripts:
// true`). Costs a few milliseconds; in CI the tree is always fresh so it is a
// no-op.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');

const REPAIR = [
  'cd pages-build',
  'rm -f node_modules/.pnpm-workspace-state-v1.json',
  'pnpm install --frozen-lockfile',
].join(' && ');

if (!existsSync(nodeModules)) {
  console.error(
    '\n[check-deps] pages-build/node_modules is missing.\n' +
      '  pages-build is its own install root — it has its own pnpm-lock.yaml and is\n' +
      '  NOT part of the repo-root pnpm workspace, so a root `pnpm install` never\n' +
      '  covers it.\n\n' +
      '  Fix:  cd pages-build && pnpm install --frozen-lockfile\n',
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const declared = Object.keys({
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
});

const missing = declared.filter(
  (name) => !existsSync(join(nodeModules, ...name.split('/'), 'package.json')),
);

if (missing.length > 0) {
  console.error(
    `\n[check-deps] node_modules is physically incomplete — ${missing.length} of ` +
      `${declared.length} direct dependencies are not on disk:\n` +
      missing.map((name) => `  - ${name}`).join('\n') +
      '\n\n' +
      '  pnpm will NOT fix this on its own. It trusts its recorded install state, so\n' +
      '  `pnpm install`, `--frozen-lockfile`, and even `--force` all report "Already\n' +
      '  up to date" and change nothing. Delete the state file to force a real relink:\n\n' +
      `    ${REPAIR}\n\n` +
      '  (~1s — pnpm relinks only what is missing. `rm -rf node_modules && pnpm\n' +
      '  install` also works but is far slower.)\n',
  );
  process.exit(1);
}
