import { describe, expect, it } from 'vitest';
import { RevTurbineConfigSchema } from '@revt-eng/schema';
import bundledConfig from './prism-export-config.json';

/**
 * Guards the Prism playground's authored config (plan 81 TASK-1, REQ-6/AC-6).
 *
 * `prism-export-config.json` is authored directly in this repo — it is no longer
 * synced from revturbine-demo-data (plan 105). These tests make the contract real:
 *
 *  1. It MUST validate against `RevTurbineConfigSchema` — the same parse
 *     `prism-config.ts` does at load time, but as a CI gate so the playground
 *     can't ship an invalid config undetected. `pnpm typecheck:prism-config`
 *     enforces the same at build time.
 *  2. It MUST keep exercising the breadth of capabilities the demo is for, so a
 *     careless edit can't silently drop a capability.
 */
describe('Prism playground authored config', () => {
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
});
