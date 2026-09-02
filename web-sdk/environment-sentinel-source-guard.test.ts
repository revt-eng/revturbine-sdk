import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const THIS_FILE = 'web-sdk/environment-sentinel-source-guard.test.ts';
const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mdx',
  '.mjs',
  '.py',
  '.rs',
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.venv',
  'dist',
  'node_modules',
  'sdk-docs',
  'target',
]);
const IGNORED_FILES = new Set([
  'pnpm-lock.yaml',
  'server-python/src/revturbine/types.py',
  'server-rust/src/types.rs',
  'server-rust/Cargo.lock',
  'tests/parity/rust_runner/Cargo.lock',
  'web-sdk/generated.ts',
]);
const ENVIRONMENT_FIELD = /\benvironment(?:Id|_id)\b/i;
const LEGACY_ENVIRONMENT_LITERAL = /(['"`])(?:default|prod)\1/i;

function repoRelative(filePath: string): string {
  return relative(REPO_ROOT, filePath).split(sep).join('/');
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...sourceFiles(join(directory, entry.name)));
      }
      continue;
    }

    const filePath = join(directory, entry.name);
    const path = repoRelative(filePath);
    if (path !== THIS_FILE
      && !IGNORED_FILES.has(path)
      && !path.startsWith('web-sdk/generated/')
      && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(filePath);
    }
  }
  return files;
}

describe('production environment sentinel source guard', () => {
  it('rejects legacy environment literals in runtime, tests, fixtures, and examples', () => {
    const violations: string[] = [];
    for (const filePath of sourceFiles(REPO_ROOT)) {
      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (ENVIRONMENT_FIELD.test(line) && LEGACY_ENVIRONMENT_LITERAL.test(line)) {
          violations.push(`${repoRelative(filePath)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
