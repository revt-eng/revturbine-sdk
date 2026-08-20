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
 * Two directions are asserted, and both matter:
 *
 *  1. **Docs ⊆ emitted.** Every backticked `snake_case` code in an
 *     entitlement reason table resolves to a code the SDK can produce.
 *  2. **Emitted ⊆ real.** Every member of the canonical set appears literally
 *     in the shipping sources (`customer-side.ts` or the `@revt-eng/core`
 *     evaluator). Without this half the canonical list is just a second
 *     fiction that happens to agree with the first — a rename in the SDK
 *     would leave both wrong and both green.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/**
 * Every entitlement `reason` the SDK can return.
 *
 * Rule outcomes come from the `@revt-eng/core` evaluator; infrastructure
 * denials from `customer-side.ts`. The two limit codes additionally carry an
 * enforcement suffix (`_soft_block` / `_degraded` / `_overage`), generated
 * rather than written out, so the suffixes are listed separately.
 */
const EMITTED_BASE = [
  // Rule outcomes (core evaluator).
  'no_matching_entitlement_rule',
  'feature_not_enabled_for_plan',
  'usage_limit_reached',
  'credit_balance_exhausted',
  'granted_by_reverse_trial',
  // Infrastructure denials (web-sdk).
  'config_unavailable',
  'entitlement_not_in_playbook',
  'sdk_disabled_provider_failure',
] as const;

const ENFORCEMENT_SUFFIXES = ['_soft_block', '_degraded', '_overage'] as const;
const SUFFIXABLE = ['usage_limit_reached', 'credit_balance_exhausted'] as const;

const EMITTED = new Set<string>([
  ...EMITTED_BASE,
  ...SUFFIXABLE.flatMap((base) => ENFORCEMENT_SUFFIXES.map((s) => `${base}${s}`)),
]);

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

  it('every canonical code appears in the shipping sources', () => {
    // The core evaluator is code-split across dist chunks, so scan the whole
    // build rather than guessing an entry point — a wrong path here would
    // make this half pass by reading nothing.
    const coreDist = resolve(REPO, 'node_modules/@revt-eng/core/dist');
    const coreFiles = readdirSync(coreDist).filter((f) => f.endsWith('.js'));
    expect(coreFiles.length, 'no @revt-eng/core dist files found to scan').toBeGreaterThan(0);

    const sources = [
      readFileSync(join(REPO, 'web-sdk/customer-side.ts'), 'utf8'),
      ...coreFiles.map((f) => readFileSync(join(coreDist, f), 'utf8')),
    ].join('\n');

    const missing = EMITTED_BASE.filter((code) => !sources.includes(code));
    expect(missing, 'canonical reason code(s) not found in any shipping source').toEqual([]);
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
