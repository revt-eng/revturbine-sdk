/**
 * The docs playground's demo Playbook must actually decide (BL-0401).
 *
 * `src/sandpack/example-playbook.json` is mounted into every playground
 * scenario and every "Run this example" sandbox, and the host-side playground
 * renders against it too. It sat in the retired RevTurbineConfig body for
 * months: rules referenced entitlements by a dropped config-level id
 * (`ent_data_export`), carried `plan_ids` instead of `targets`, and segments had
 * no handle. The legacy header normalized, the SDK loaded it, and then every
 * rule failed the handle comparison — every entitlement denied for every demo
 * user, silently. Nothing ran the fixture through the schema or the SDK.
 *
 * This test does both: it parses the fixture with `PlaybookStrictSchema`, and it
 * runs every gate scenario in `scenarios.ts` through the published SDK (the
 * same `@revturbine/sdk` the playground renders with) for every demo user, so
 * the playground can never silently deny again.
 */
import { describe, expect, it } from 'vitest';
import { PlaybookStrictSchema } from '@revt-eng/schema';
import { initRevTurbine, RuntimeMode } from '@revturbine/sdk/headless';
import playbook from '../src/sandpack/example-playbook.json';
import { sandpackScenarios } from '../src/sandpack/scenarios';
import { demoUsers, type DemoUserContext } from '../src/sandpack/demoUsers';
import { DEMO_USER_IDS, type DemoUserId } from '../src/sandpack/shared';

describe('example-playbook.json is a canonical Playbook', () => {
  it('parses with PlaybookStrictSchema', () => {
    const parsed = PlaybookStrictSchema.safeParse(playbook);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 5))).toBe(true);
    expect(playbook.artifact_type).toBe('playbook');
    expect(playbook.format_version).toBe('1.0.0');
  });

  it('binds every rule by handle: entitlement, plan and add-on targets all resolve', () => {
    const entitlementHandles = new Set(playbook.entitlements.map((e) => e.unique_handle));
    const planHandles = new Set(playbook.plans.map((p) => p.unique_handle));
    const addonHandles = new Set(playbook.addons.map((a) => a.unique_handle));
    for (const rule of playbook.entitlement_rules) {
      expect(entitlementHandles, `rule ${rule.id} → ${rule.entitlement_id}`).toContain(rule.entitlement_id);
      expect(rule.targets.length, `rule ${rule.id} has no targets`).toBeGreaterThan(0);
      for (const t of rule.targets) {
        const pool = t.kind === 'plan' ? planHandles : addonHandles;
        expect(pool, `rule ${rule.id} → ${t.kind} ${t.id}`).toContain(t.id);
      }
    }
  });

  it('every demo user is on a plan the Playbook defines', () => {
    const planHandles = new Set(playbook.plans.map((p) => p.unique_handle));
    for (const id of DEMO_USER_IDS) {
      expect(planHandles, id).toContain(demoUsers[id].context.plan.handle);
    }
  });
});

/** What each plan is entitled to among the gated features. */
const GRANTED_PLANS = new Set(['professional', 'enterprise']);

const gateScenarios = sandpackScenarios.filter(
  (s) => s.component === 'Gate' || s.component === 'HeadlessEntitlementGate',
);

async function sessionFor(userId: DemoUserId) {
  // Widened to the shared context type so every demo user fits one call site.
  const user: DemoUserContext = demoUsers[userId].context;
  return initRevTurbine({
    runtimeMode: RuntimeMode.LocalOnly,
    // Keep the test out of SDK adoption telemetry, exactly as the docs demos do.
    previewMode: true,
    localRuntime: { playbook },
    user,
    uiPathResolvers: {
      navigate_to_plans: async () => {},
      open_checkout_modal: async () => {},
      book_demo: async () => {},
      custom_url: async () => {},
    },
  });
}

describe('every playground gate scenario decides per user through the real SDK', () => {
  it('covers the gate scenarios the playground ships', () => {
    expect(gateScenarios.map((s) => s.code)).toEqual(['G-1', 'G-2', 'G-3', 'H-2']);
  });

  for (const scenario of gateScenarios) {
    const handle = scenario.entitlementHandle as string;

    describe(`${scenario.code} ${scenario.title} (${handle})`, () => {
      for (const userId of DEMO_USER_IDS) {
        const plan = demoUsers[userId].context.plan.handle;
        const granted = GRANTED_PLANS.has(plan);

        it(`${userId} (${plan}) is ${granted ? 'granted' : 'denied with the upgrade payload'}`, async () => {
          const session = await sessionFor(userId);
          const result = await session.can(handle);

          // The gated upsell the <Gate> renders on denial: the same surface slot
          // `AccessGateSurfaceSlot` builds for its placement lookup.
          const ctrl = session.placement({
            surfaceSlot: {
              id: scenario.slotId,
              name: scenario.slotId,
              surfaceTemplateIds: scenario.surfaceTemplateIds,
              metadata: { surface_slot_category: 'gated', entitlement_handle: handle },
            },
          });
          const decision = await ctrl.load();
          ctrl.dispose();

          if (granted) {
            expect(result).toMatchObject({ status: 'allowed', allowed: true });
            expect(result.reason).toBeUndefined();
            // Bound by handle — the very comparison the legacy fixture failed.
            expect(result.rule_handle).toBeTruthy();
            expect(decision?.visible ?? false).toBe(false);
          } else {
            expect(result).toMatchObject({
              status: 'denied',
              allowed: false,
              reason: 'feature_not_enabled_for_plan',
            });
            expect(decision?.visible).toBe(true);
            expect(decision?.content).toBeTruthy();
          }
        });
      }
    });
  }

  it('Alice (professional) is granted data_export — the G-1 regression', async () => {
    const session = await sessionFor('user_alice');
    expect(await session.can('data_export')).toMatchObject({
      status: 'allowed',
      allowed: true,
      rule_handle: 'ev_data_export_enabled',
    });
  });
});
