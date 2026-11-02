/**
 * ST-1418: this file pinned the `@deprecated` tag on every arm of the
 * `playbook` / `exportedConfig` option unions (BL-0172). Those unions are gone
 * in 0.13.0; it now asserts the removed names no longer appear in the public
 * option surfaces, so a re-added alias fails here (the alias manifest in
 * `tests/parity/facade-surface.json` is the companion gate).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as fixture from './playbook-deprecation-arms.fixture';
import { REMOVED_ALIAS_NAMES } from './playbook-option';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const REMOVED = REMOVED_ALIAS_NAMES;

describe('removed ExportedConfig-era aliases stay removed', () => {
  it('the type probe fixture compiles (checked by check:types:exact)', () => {
    expect(fixture.noLegacyLocalRuntimeKey).toBe(true);
  });

  for (const file of ['./customer-side.ts', './browser-runtime.ts', '../server-node/local-server.ts']) {
    it(`${file} declares none of the removed names`, () => {
      const source = read(file);
      // browser-runtime keeps one Omit of core's own key; it is not an SDK option.
      const stripped = source.replace(/'exportedConfig'/g, '');
      for (const name of REMOVED) {
        expect(stripped, `${name} in ${file}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    });
  }

  it('index.ts no longer re-exports Playbook as ExportedConfig', () => {
    expect(read('./index.ts')).not.toMatch(/as ExportedConfig\b/);
  });
});
