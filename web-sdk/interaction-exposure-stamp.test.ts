/**
 * ST-912 TASK-1 — the exposure stamp on the interaction wire.
 *
 * The impression a `PlacementController` fires carries the slot type that
 * triggered it (`trigger_source: 'gate'` + `entitlement_handle`) and the
 * configured `playbook_version`, read from the slot record the controller
 * itself registered. Real SDK, real controller, stubbed `fetch`; each path once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacementOutput } from '@revt-eng/core';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions, RevTurbineSurfaceSlotConfig } from './customer-side';
import { PlacementController } from './controllers';

const INTERACTIONS_PATH = '/api/events/interactions';
const USER = 'user_1';
let bodies: Array<Record<string, unknown>> = [];

const output: PlacementOutput = {
  output_id: 'payload_gate',
  rule_id: 'rule_gate',
  decision_id: 'dec_gate',
  config_version: 'v1',
  category: 'upsell',
  surface: { type: 'banner', template: 'banner_placement', slot_id: 'slot_gate' },
  content: { header: 'Upgrade to export' },
  cta_path: { type: 'navigate_to_plans', plan_handle: 'pro' },
  present_upsell: true,
};

function newSdk(playbookVersion?: string): RevTurbineCustomerSdk {
  const options = {
    tenantId: 'tenant_912',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    user: { id: USER },
    localRuntime: {
      resolvers: {
        getPlacementDecision: async (input: { placementId: string }) => ({
          placementId: input.placementId,
          requestId: 'rid_912',
          visible: true,
          decisionSource: 'local' as const,
          reasonCodes: [],
          content: output.content,
          output,
        }),
      },
    },
  } satisfies Partial<RevTurbineInitOptions>;
  const sdk = new RevTurbineCustomerSdk(options);
  if (playbookVersion) {
    (sdk as unknown as { configProvider: unknown }).configProvider = {
      getPlaybook: () => ({ playbook_version_id: playbookVersion }),
    };
  }
  return sdk;
}

/** Render `surfaceSlot` through a real controller and return the impression body it sent. */
async function impressionFor(
  sdk: RevTurbineCustomerSdk,
  surfaceSlot: RevTurbineSurfaceSlotConfig,
): Promise<Record<string, unknown>> {
  const controller = new PlacementController(sdk, { surfaceSlot, userId: USER });
  await controller.load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.dispose();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].interaction_type).toBe('impression');
  return bodies[0];
}

beforeEach(() => {
  bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes(INTERACTIONS_PATH)) bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the impression of a gate-requested slot carries the exposure stamp', () => {
  it('stamps trigger_source, entitlement_handle and the configured playbook_version', async () => {
    const body = await impressionFor(newSdk('pbv_912'), {
      id: 'slot_gate',
      name: 'slot_gate',
      metadata: { surface_slot_category: 'gated', entitlement_handle: 'export_pdf' },
    });
    expect(body).toMatchObject({
      trigger_source: 'gate',
      entitlement_handle: 'export_pdf',
      playbook_version: 'pbv_912',
    });
  });

  it('a plain surface slot carries neither trigger_source nor entitlement_handle', async () => {
    const body = await impressionFor(newSdk('pbv_912'), { id: 'slot_plain', name: 'slot_plain' });
    expect(body).not.toHaveProperty('trigger_source');
    expect(body).not.toHaveProperty('entitlement_handle');
    expect(body.playbook_version).toBe('pbv_912');
  });

  it('a client without a configured Playbook omits playbook_version', async () => {
    const body = await impressionFor(newSdk(), {
      id: 'slot_gate',
      name: 'slot_gate',
      metadata: { surface_slot_category: 'gated', entitlement_handle: 'export_pdf' },
    });
    expect(body.trigger_source).toBe('gate');
    expect(body).not.toHaveProperty('playbook_version');
  });
});
