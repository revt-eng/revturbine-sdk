#!/usr/bin/env node
/**
 * check-no-internal-pkg.mjs — CI guard: no internal @revt-eng/* package name
 * reaches the public docs.
 *
 * The published SDK is `@revturbine/sdk`. The internal *source* package is
 * `@revt-eng/sdk` (GitHub Packages), which the publish mirror renames. If an
 * internal name leaks into the docs — or into a customer-facing TSDoc @example
 * that TypeDoc renders into the API reference and llms-full.txt — a coding agent
 * reading the docs will `npm install` the wrong package. This guard fails the
 * build on any such leak. (Plan 139 REQ-6 / REQ-7 / AC-5.)
 *
 * Two blocking scans:
 *   1. Doc content (`src/content/docs`, excluding the generated `api/` dir):
 *      ANY `@revt-eng` reference is a failure.
 *   2. web-sdk source: a customer-facing example/module leak — `from
 *      '@revt-eng/sdk'` or `@module @revt-eng/sdk` — is a failure. Legitimate
 *      internal build identity (e.g. package.json `"name"`, real
 *      `@revt-eng/schema` imports) does not match these patterns and is left
 *      alone.
 *
 * Usage: node scripts/check-no-internal-pkg.mjs   (run from pages-build/)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DOCS = join(ROOT, 'src', 'content', 'docs');
const API_DIR = join(DOCS, 'api'); // generated — regenerated clean from web-sdk TSDoc
const WEB_SDK = join(ROOT, '..', 'web-sdk');
const SKIP_DIRS = ['node_modules', 'dist', 'sdk-docs', 'coverage', '.astro', '.snippet-check'];

/** Recursively collect files under `dir` matching `test`, skipping SKIP_DIRS and `skipPaths`. */
function walk(dir, test, skipPaths = []) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.includes(name)) continue;
    const p = join(dir, name);
    if (skipPaths.some((s) => p.startsWith(s))) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p, test, skipPaths));
    else if (test(name)) out.push(p);
  }
  return out;
}

const failures = [];

function scan(files, matches) {
  for (const file of files) {
    const rel = relative(ROOT, file);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (matches(line)) failures.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
}

// Scan 1 — doc content must be free of every @revt-eng reference.
scan(
  walk(DOCS, (n) => /\.mdx?$/.test(n), [API_DIR]),
  (line) => line.includes('@revt-eng'),
);

// Scan 2 — web-sdk TSDoc must not show the internal install name to customers.
const LEAK = /from '@revt-eng\/sdk|@module @revt-eng\/sdk/;
scan(
  walk(WEB_SDK, (n) => /\.tsx?$/.test(n)),
  (line) => LEAK.test(line),
);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} internal @revt-eng reference(s) leaking toward the docs:\n`);
  for (const f of failures) console.error('  • ' + f);
  console.error(
    `\nThe published package is @revturbine/sdk. Replace the internal name (or reword) ` +
      `so no @revt-eng/* reaches a reader.\n`,
  );
  process.exit(1);
}

console.log('✓ No internal @revt-eng/* package names leak toward the docs.');
