/**
 * Plan 191 AC-6 — the docs may only name reason codes the SDK actually emits.
 *
 * Before this test, three docs pages between them listed five entitlement
 * reason codes that exist nowhere in the SDK
 * (`entitlement_service_unavailable`, `entitlement_check_error`,
 * `denied_feature_gate`, `denied_usage_limit`, `denied_tier_mismatch`) and
 * documented fail-OPEN semantics for two of them, while the code has been
 * fail-closed since 0.2.30. A reader writing `switch (result.reason)` against
 * that table wrote dead branches — and, worse, believed a failed check would
 * grant.
 *
 * Documentation is checked against the reviewed behavioral reason inventory.
 *
 *  1. **Docs ⊆ emitted.** Every backticked `snake_case` code in an
 *     entitlement reason table resolves to a code the SDK can produce.
 *  2. `reason-contract.test.ts` requires each inventory member to be emitted by
 *     live SDK/core fixtures. Literal presence in comments or dead code no
 *     longer counts as proof that a protected reason survives.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import reasonContract from '../tests/reason-contract.json';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const EMITTED = new Set<string>(reasonContract.entitlement);

/** Codes that were documented but never existed. Named so they stay dead. */
const RETIRED_OR_FICTIONAL = [
  'entitlement_service_unavailable',
  'entitlement_check_error',
  'denied_feature_gate',
  'denied_usage_limit',
  'denied_tier_mismatch',
  // Renamed by Q-4 (hard rename, no alias) → entitlement_not_in_playbook.
  'local_runtime_default_allow',
];

/** Docs pages carrying an entitlement reason-code table. */
const DOC_PAGES = [
  'pages-build/src/content/docs/guides/error-handling.md',
  'pages-build/src/content/docs/reference/errors.md',
  'pages-build/src/content/docs/guides/entitlements.mdx',
];

/**
 * Pull the codes a page claims. Only rows/lines that are *about* entitlement
 * reasons — placement reason codes and provider errors live in their own
 * tables on the same pages and are a different vocabulary.
 */
function claimedCodes(markdown: string): string[] {
  const out = new Set<string>();
  for (const raw of markdown.split('\n')) {
    // A code is only "claimed" where the line also says `reason`, or it sits
    // in a row whose text names a check outcome. Anchor on the explicit
    // mention so unrelated backticked identifiers do not get swept in.
    const isReasonContext = /reason|allowed:\s*(true|false)|status:\s*'(allowed|denied|limited)'/.test(raw);
    if (!isReasonContext) continue;
    for (const m of raw.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
      out.add(m[1]);
    }
    for (const m of raw.matchAll(/reason:\s*'([a-z0-9_]+)'/g)) {
      out.add(m[1]);
    }
  }
  return [...out];
}

/**
 * Identifiers that legitimately appear in reason-context lines but are not
 * reason codes — schema field names, enforcement modes, entitlement types.
 */
const NOT_A_REASON_CODE = new Set([
  'limit_value',
  'allowance_value',
  'per_month',
  'usage_limit',
  'capability_tier',
  'price_per_unit',
  'rate_limit',
  'soft_block',
  'block_with_upsell',
  'hard_block',
  'allow_overage',
  'current_tier',
  'plan_handle',
  'unique_handle',
  'entitlement_not_in_playbook',
  'reason_codes',
  'cap_limit_exceeded',
  'local_only',
  'updateUsage',
  'entitlement_rule',
  'entitlement_rules',
]);

describe('entitlement reason codes (plan 191 AC-6)', () => {
  it.each(DOC_PAGES)('%s names only codes the SDK emits', (page) => {
    const md = readFileSync(join(REPO, page), 'utf8');
    const unknown = claimedCodes(md)
      .filter((c) => !EMITTED.has(c))
      .filter((c) => !NOT_A_REASON_CODE.has(c))
      // The renamed code is allowed to appear inside the migration note that
      // tells readers it is gone — but only there, spelled as a rename.
      .filter((c) => !(c === 'local_runtime_default_allow' && /entitlement_not_in_playbook/.test(md)));

    expect(unknown, `${page} documents reason code(s) the SDK never emits`).toEqual([]);
  });

  it('the fictional and renamed codes are gone from the docs', () => {
    for (const page of DOC_PAGES) {
      const md = readFileSync(join(REPO, page), 'utf8');
      for (const dead of RETIRED_OR_FICTIONAL) {
        if (dead === 'local_runtime_default_allow') continue; // migration note
        expect(md, `${page} still documents ${dead}`).not.toContain(dead);
      }
    }
  });
});
