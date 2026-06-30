import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RevTurbineConfigSchema } from '@revt-eng/schema';
import bundledConfig from './prism-export-config.json';

/**
 * Guards the Prism playground's bundled config (plan 81 TASK-1, REQ-6/AC-6).
 *
 * The playground bundles `prism-export-config.json` so it runs with no cross-repo
 * dependency. The canonical source of truth lives in revturbine-demo-data
 * (`customers/prism/export-config.json`). These tests make the contract real:
 *
 *  1. The bundled copy MUST validate against `RevTurbineConfigSchema` — the same
 *     parse `prism-config.ts` does at load time, but as a CI gate so the
 *     playground can't ship an invalid config undetected.
 *  2. It MUST keep exercising the breadth of capabilities the demo is for, so a
 *     careless edit can't silently drop a capability.
 *  3. When revturbine-demo-data is checked out as a sibling (the umbrella layout
 *     + pre-commit), the bundled copy MUST byte-match the canonical. In isolated
 *     SDK CI the sibling is absent, so that check is skipped (loudly) — the
 *     schema-validity gate above is the CI-authoritative guard, and the canonical
 *     is independently validated by `revturbine-cli verify prism`.
 */
describe('Prism playground bundled config', () => {
  it('validates against RevTurbineConfigSchema', () => {
    const result = RevTurbineConfigSchema.safeParse(bundledConfig);
    if (!result.success) {
      throw new Error(
        `prism-export-config.json is not a valid RevTurbineConfig:\n${JSON.stringify(
          result.error.issues,
          null,
          2,
        )}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it('exercises the demo capability breadth', () => {
    const config = RevTurbineConfigSchema.parse(bundledConfig);

    // Entitlement types the demo showcases — dropping one is a breadth regression.
    const entitlementTypes = new Set(config.entitlements.map((e) => e.type));
    for (const type of ['feature', 'capability_tier', 'usage_limit', 'credits', 'rate_limit', 'seat']) {
      expect(entitlementTypes, `entitlement type "${type}" missing`).toContain(type);
    }

    // Placement categories the demo showcases (TASK-5 added trials + retention).
    const categories = new Set((config.placements ?? []).map((p) => p.category));
    for (const category of ['fixed', 'gated', 'usage_credit_seat', 'other_conversion', 'trials', 'retention']) {
      expect(categories, `placement category "${category}" missing`).toContain(category);
    }

    // Free + reverse trial rules (reverse grants premium without a plan change).
    expect(config.free_trial_rules?.length, 'no free_trial_rules').toBeGreaterThan(0);
    expect(config.reverse_trial_rules?.length, 'no reverse_trial_rules').toBeGreaterThan(0);
    expect(config.reverse_trial_rules?.[0]?.entitlements_during_trial.length, 'reverse trial grants nothing').toBeGreaterThan(0);

    // Targeting must stay live: at least one segment-targeted payload.
    const hasSegmentTargeting = (config.placements ?? []).some((p) =>
      p.payloads.some((pl) => pl.target.segment_chips.length > 0),
    );
    expect(hasSegmentTargeting, 'no segment-targeted payload — targeting is dark').toBe(true);
  });

  const canonicalPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'revturbine-demo-data',
    'customers',
    'prism',
    'export-config.json',
  );
  const hasCanonical = existsSync(canonicalPath);

  it.skipIf(!hasCanonical)('byte-matches the revturbine-demo-data canonical', () => {
    const canonical = readFileSync(canonicalPath, 'utf8');
    const bundled = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'prism-export-config.json'),
      'utf8',
    );
    expect(bundled, 'bundled config drifted from the demo-data canonical — run `pnpm sync:prism-config`').toBe(canonical);
  });

  if (!hasCanonical) {
    // Not a silent skip: name the gap so a green run here isn't mistaken for
    // canonical-parity coverage (it isn't, in isolated SDK CI).
    // eslint-disable-next-line no-console
    console.warn(
      '[prism-config] revturbine-demo-data sibling not found — skipping bundled↔canonical byte check. ' +
        'Schema validity is still enforced above; canonical parity is enforced in the umbrella / pre-commit.',
    );
  }
});
