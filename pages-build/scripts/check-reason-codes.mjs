#!/usr/bin/env node
/**
 * check-reason-codes.mjs — CI guard: the docs' placement reason-code tables
 * agree with the public reason contract (BL-0407).
 *
 * Sibling of `lint:config` (check-config-examples.mjs), which validates
 * Playbook JSON examples against the schema. This validates the *reason-code*
 * tables in `src/content/docs/reference/errors.md` and
 * `src/content/docs/guides/error-handling.md` against
 * `tests/reason-contract.json` — the same file `web-sdk/reason-contract.test.ts`
 * enforces against live SDK fixtures. It fails when:
 *
 *   - a documented placement code is not (or no longer) in the contract, or
 *   - a contract placement code is not documented.
 *
 * This is a thin wrapper around gen-reason-codes.mjs's own `--check` mode
 * (which does the actual comparison by re-rendering the table from the
 * contract and diffing it against what's on disk) so there is exactly one
 * place — the DESCRIPTIONS map — that has to be kept in sync with the
 * contract, and one gate that fails when it isn't.
 *
 * Usage: node scripts/check-reason-codes.mjs   (run from pages-build/)
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const GEN_SCRIPT = join(ROOT, 'scripts', 'gen-reason-codes.mjs');

try {
  execFileSync(process.execPath, [GEN_SCRIPT, '--check'], { stdio: 'inherit' });
} catch (err) {
  process.exit(err.status ?? 1);
}
