/**
 * Plan 174 TASK-3 (F-69a) — every client-consumed React module ships
 * `'use client'`.
 *
 * Before this change `RevTurbineProvider`, `<Slot>`, and two dozen sibling
 * modules lacked the directive, so App Router users had to author their own
 * client boundary while the docs claimed support unqualified. This guard
 * makes the sweep regression-proof: any `.tsx` module under `react/` or
 * `placements/` (and any `.ts` module there with a runtime `react` import)
 * must open with the directive. Pure-logic `.ts` modules (registry,
 * cta-resolvers, types, barrels) stay server-importable and are exempt by
 * construction.
 *
 * Plan: docs/dev-lifecycle/inprogress/174-spec-check-remediation-batch.md
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_SDK_ROOT = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_TREES = ['react', 'placements'];

/** Leading trivia (whitespace + comments) then the directive. */
const OPENS_WITH_USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"];?/;
/** A runtime (non-type-only) import from react. */
const RUNTIME_REACT_IMPORT = /^import\s+(?!type\b)[^;]*from\s+['"]react['"]/m;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

function clientModules(): string[] {
  return CLIENT_TREES.flatMap((tree) => walk(join(WEB_SDK_ROOT, tree)))
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.(test|stories|spec)\./.test(file))
    .filter((file) => {
      if (file.endsWith('.tsx')) return true;
      return RUNTIME_REACT_IMPORT.test(readFileSync(file, 'utf8'));
    });
}

describe("client-module 'use client' guard (AC-3)", () => {
  it('finds a non-trivial set of client modules (sanity)', () => {
    expect(clientModules().length).toBeGreaterThanOrEqual(26);
  });

  it("every client module opens with 'use client'", () => {
    const missing = clientModules().filter(
      (file) => !OPENS_WITH_USE_CLIENT.test(readFileSync(file, 'utf8')),
    );
    expect(missing, `modules missing 'use client':\n${missing.join('\n')}`).toEqual([]);
  });
});
