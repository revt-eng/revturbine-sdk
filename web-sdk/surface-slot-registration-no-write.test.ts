/**
 * BL-0197 — `registerSurfaceSlot()` performs no server-side write.
 *
 * Production defect (dogfood_event_explorer, 2026-09-24 18:36 UTC, request
 * `030ccf51-d74b-4d55-bf4e-2a929a4ab297`): every non-`local_only` slot
 * registration rejected with `surface_slot_create_failed:422`, which the React
 * runtime surfaced as `slot_error`. `upsertSurfaceSlot()` PUT a legacy
 * surface-slot body to `/api/placements/<slot id>` (404 — no such placement)
 * and then POSTed it to `/api/placements`, RevTurbine's *authored-config* CRUD,
 * which validates against `PlacementSchema` and rejects a body with no `handle`
 * and no `category`.
 *
 * The write was wrong in principle as well as in shape: on a same-origin
 * integration the signed-in user's session cookie authenticates the request, so
 * a body the route *did* accept would have created a draft placement in the
 * tenant's Playbook just from loading a gated page. Only the 422 prevented it.
 *
 * Contract now: registration is client-local, discovery is ingestion-driven
 * (the `slot_*` telemetry the SDK already emits through `/api/track`), and the
 * only write path is an explicit `endpointOverrides.surfaceSlots` — exactly
 * like `persistPlacementTypes`. There is no fallback to `/api/placements`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

const SLOT_ID = 'slot_event_explorer_upgrade';
const TENANT = 'tenant_bl0197';

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: TENANT,
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    // The defect only ever reproduced OUTSIDE local_only; `local_only` already
    // short-circuited the write, which is why the bug reached production.
    runtimeMode: 'revturbine_server',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    user: { id: 'user_1' },
    ...over,
  } as unknown as RevTurbineInitOptions);
}

/** Every URL the SDK fetched, in order. */
function requestedUrls(): string[] {
  const spy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return spy.mock.calls.map((call) => String(call[0]));
}

function requestsTo(fragment: string): unknown[][] {
  const spy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return spy.mock.calls.filter((call) => String(call[0]).includes(fragment));
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ({ ok: true, status: 202, json: async () => ({}), text: async () => '' }) as unknown as Response,
    ),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('BL-0197 — default registration writes nothing to the control plane', () => {
  it('resolves without calling /api/placements at all', async () => {
    const sdk = makeSdk();

    const placementId = await sdk.registerSurfaceSlot({ id: SLOT_ID, name: 'Upgrade banner' });

    expect(placementId).toBeTruthy();
    expect(requestsTo('/api/placements')).toEqual([]);
  });

  it('does not reject when the authored-config CRUD would have 422d', async () => {
    // Replay the production failure: the route answers 404 to the PUT and 422
    // to the POST. Before the fix this threw `surface_slot_create_failed:422`;
    // now nothing is sent there, so the shape of those answers is irrelevant.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string }) => {
        if (String(input).includes('/api/placements')) {
          return {
            ok: false,
            status: init?.method === 'PUT' ? 404 : 422,
            json: async () => ({ error: 'invalid_placement' }),
            text: async () => 'invalid_placement',
          } as unknown as Response;
        }
        return { ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response;
      }),
    );

    await expect(sdkRegister()).resolves.toBeTruthy();
    expect(requestsTo('/api/placements')).toEqual([]);

    async function sdkRegister() {
      return makeSdk().registerSurfaceSlot({ id: SLOT_ID, name: 'Upgrade banner' });
    }
  });

  it('performs zero writes of any kind for a plain registration', async () => {
    const sdk = makeSdk();

    await sdk.registerSurfaceSlot({ id: SLOT_ID, name: 'Upgrade banner' });

    // Telemetry is allowed to leave (it goes to /api/track); an authored-config
    // write is not. Assert on the whole URL list so a NEW default write path
    // cannot be introduced silently.
    const writes = requestedUrls().filter((url) => !url.includes('/api/track') && !url.includes('/api/sdk/'));
    expect(writes).toEqual([]);
  });

  it('keeps the registration usable — the slot is in the local inventory', async () => {
    const sdk = makeSdk();

    const placementId = await sdk.registerSurfaceSlot({ id: SLOT_ID, name: 'Upgrade banner' });

    expect(sdk.getRegisteredSlots().map((entry) => entry.slotId)).toContain(SLOT_ID);
    expect(placementId).toBeTruthy();
  });
});

describe('BL-0197 — the explicit surfaceSlots override still writes', () => {
  it('PUTs to the configured endpoint, never to /api/placements', async () => {
    const sdk = makeSdk({
      runtimeMode: 'custom_endpoints',
      endpointOverrides: { surfaceSlots: 'https://slots.example.com/inventory' },
    } as unknown as Partial<RevTurbineInitOptions>);

    await sdk.registerSurfaceSlot({ id: SLOT_ID, name: 'Upgrade banner' });

    const written = requestsTo('slots.example.com/inventory');
    expect(written.length).toBeGreaterThan(0);
    expect((written[0][1] as { method?: string }).method).toBe('PUT');
    expect(requestsTo('/api/placements')).toEqual([]);
  });

  it('falls through to POST on the override base when the PUT 404s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string }) => {
        if (String(input).includes('slots.example.com') && init?.method === 'PUT') {
          return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response;
      }),
    );

    const sdk = makeSdk({
      runtimeMode: 'custom_endpoints',
      endpointOverrides: { surfaceSlots: 'https://slots.example.com/inventory' },
    } as unknown as Partial<RevTurbineInitOptions>);

    await sdk.registerSurfaceSlot({ id: SLOT_ID, name: 'Upgrade banner' });

    const methods = requestsTo('slots.example.com').map((call) => (call[1] as { method?: string }).method);
    expect(methods).toEqual(['PUT', 'POST']);
    // The fallback stays on the OVERRIDE base. `/api/placements` is never a
    // fallback for anything, which is the whole point of BL-0197.
    expect(requestsTo('/api/placements')).toEqual([]);
  });
});
