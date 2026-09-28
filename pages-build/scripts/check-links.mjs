#!/usr/bin/env node
/**
 * check-links.mjs — Validate internal links in built HTML files.
 *
 * Scans dist/ for <a href="..."> and checks that internal targets exist.
 * Exits with code 1 if broken links are found.
 *
 * Base-aware: the build prefixes every internal href with the site base
 * (PAGES_BASE, or /<repo>/ under GitHub Actions — the same derivation as
 * astro.config.mjs), while dist/ itself is laid out from the root. The base is
 * stripped before resolving; a root-absolute href outside the base is reported,
 * because it escapes the mount the site is served from. Before this, a build
 * with a base reported every link broken, and CI hid it behind
 * continue-on-error (BL-0406).
 *
 * Usage: node scripts/check-links.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '..', 'dist');

// Mirror astro.config.mjs's base derivation exactly.
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
const rawBase = process.env.PAGES_BASE ?? (isGithubActions && repoName ? `/${repoName}/` : '/');
const trimmed = rawBase.replace(/^\/+|\/+$/g, '');
const BASE = trimmed ? `/${trimmed}/` : '/';

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const broken = [];
  const hrefRe = /href="(\/[^"#?]*)/g;

  // Directories that have content but no index.html at root (e.g., TypeDoc API reference)
  const knownSections = ['/api/'];

  for await (const file of walk(DIST)) {
    const html = await readFile(file, 'utf-8');
    let match;
    while ((match = hrefRe.exec(html)) !== null) {
      const raw = match[1];
      if (BASE !== '/' && !raw.startsWith(BASE) && raw !== BASE.slice(0, -1)) {
        broken.push({ source: file.replace(DIST, ''), href: `${raw} (outside base ${BASE})` });
        continue;
      }
      const href = BASE === '/' ? raw : `/${raw.slice(BASE.length)}`;
      // Resolve to dist path
      const target = href.endsWith('/')
        ? join(DIST, href, 'index.html')
        : join(DIST, href);

      if (!(await exists(target))) {
        // Also check with .html extension
        if (!(await exists(target + '.html')) && !(await exists(join(target, 'index.html')))) {
          // Skip known sections that have child pages but no index
          if (knownSections.some(s => href === s || href === s.slice(0, -1))) continue;
          const relative = file.replace(DIST, '');
          broken.push({ source: relative, href });
        }
      }
    }
  }

  if (broken.length === 0) {
    console.log(`✓ All internal links valid`);
    process.exit(0);
  }

  console.error(`✗ ${broken.length} broken internal link(s):\n`);
  for (const { source, href } of broken) {
    console.error(`  ${source} → ${href}`);
  }
  process.exit(1);
}

main();
