/**
 * Plan 186 TASK-3 — the server binding resolves decisions without hooks.
 *
 * Covers AC-1 (a Server Component's `await getEntitlement(...)` grants for an
 * entitled user and denies otherwise), AC-7 (evaluation failure resolves
 * denied rather than throwing into the render tree), and AC-20 (with the
 * control plane unreachable, decisions still resolve from the bundled
 * Playbook).
 *
 * Plan: docs/dev-lifecycle/inprogress/186-server-rendering-sdk-and-api-token-management.md
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RevTurbineConfig } from '@revt-eng/schema';
import {
  createServerClient,
  getEntitlement,
  getPlacement,
  type ServerClientOptions,
} from './index';

/**
 * `brand_kit` is granted to `pro` and to nobody else — the minimum needed to
 * prove the decision is evaluated per user rather than per client. Rule refs
 * use `unique_handle` values, never `ent_*` / `plan_*` ids: an id-shaped ref
 * never links and silently fails closed, which would make a per-user test
 * pass for the wrong reason.
 */
function playbook(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [
      { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
      { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 0 },
    ],
    entitlements: [
      { unique_handle: 'brand_kit', name: 'Brand Kit', type: 'boolean' },
    ],
    entitlement_rules: [
      {
        id: 'r_brandkit_pro',
        entitlement_id: 'brand_kit',
        targets: [{ kind: 'plan', id: 'pro' }],
        segment_ids: [],
        kind: 'boolean',
        enabled: true,
      },
    ],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [
      {
        id: 'pl_upsell',
        name: 'Upsell banner',
        category: 'monetization',
        payloads: [
          {
            payload_id: 'pay_upsell_1',
            target: { plan_ids: ['free'], segment_chips: [] },
            content_link: null,
            surfaces: [],
            surface_slot_ids: [],
          },
        ],
      },
    ],
  } as unknown as RevTurbineConfig; // sdk-ok: boundary-parse — hand-authored Playbook fixture
}

function local(over: Partial<ServerClientOptions> = {}) {
  return createServerClient({ tenantId: 'tn_test', playbook: playbook(), ...over });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createServerClient', () => {
  it('defaults to local transport when a playbook is supplied', () => {
    expect(local().transport).toBe('local');
  });

  it('refuses local transport with no playbook, naming the fix', () => {
    expect(() => createServerClient({ tenantId: 'tn_test' })).toThrow(/endpoint.*apiToken|playbook/);
  });

  it('refuses remote transport without both endpoint and apiToken', () => {
    expect(() =>
      createServerClient({ tenantId: 'tn_test', transport: 'remote', endpoint: 'https://e.example' }),
    ).toThrow(/endpoint.*apiToken/);
  });

  it('does not expose the api token on the client surface', () => {
    const rt = createServerClient({
      tenantId: 'tn_test',
      transport: 'remote',
      endpoint: 'https://edge.example.com',
      apiToken: 'rtk_supersecret_value',
    });
    expect(JSON.stringify(rt)).not.toContain('rtk_supersecret_value');
    expect(Object.values(rt as unknown as Record<string, unknown>)).not.toContain(
      'rtk_supersecret_value',
    );
  });
});

describe('getEntitlement (AC-1)', () => {
  it('grants an entitled user', async () => {
    const view = await getEntitlement(local(), 'brand_kit', {
      user: { id: 'u_pro', planHandle: 'pro' },
    });
    expect(view.denied).toBe(false);
    expect(view.allowed).toBe(true);
  });

  it('denies a user whose plan carries no grant', async () => {
    const view = await getEntitlement(local(), 'brand_kit', {
      user: { id: 'u_free', planHandle: 'free' },
    });
    expect(view.denied).toBe(true);
    expect(view.allowed).toBe(false);
  });

  it('decides per user, not per client — one client serves both verdicts', async () => {
    const rt = local();
    const [pro, free] = await Promise.all([
      getEntitlement(rt, 'brand_kit', { user: { id: 'u_pro', planHandle: 'pro' } }),
      getEntitlement(rt, 'brand_kit', { user: { id: 'u_free', planHandle: 'free' } }),
    ]);
    expect(pro.denied).toBe(false);
    expect(free.denied).toBe(true);
  });

  it('carries no client-only lifecycle fields (REQ-10)', async () => {
    const view = await getEntitlement(local(), 'brand_kit', {
      user: { id: 'u_pro', planHandle: 'pro' },
    });
    expect(view).not.toHaveProperty('isLoading');
    expect(view).not.toHaveProperty('recheck');
    expect(Object.keys(view).sort()).toEqual(
      ['allowed', 'denied', 'gatedPlacement', 'limited', 'result'],
    );
  });
});

describe('fail-closed (AC-7)', () => {
  it('resolves denied instead of throwing when evaluation fails', async () => {
    const rt = local();
    // A Playbook that resolves but whose runtime construction will throw when
    // the decision is attempted — the shape of any mid-evaluation failure.
    vi.spyOn(rt as unknown as { runtimeFor: () => unknown }, 'runtimeFor').mockImplementation(() => {
      throw new Error('evaluator exploded');
    });

    const view = await getEntitlement(rt, 'brand_kit', { user: { id: 'u_pro', planHandle: 'pro' } });
    expect(view.denied).toBe(true);
    expect(view.allowed).toBe(false);
    expect(view.result).toBeNull();
  });

  it('hides the placement instead of throwing when a decision fails', async () => {
    const rt = local();
    vi.spyOn(rt as unknown as { runtimeFor: () => unknown }, 'runtimeFor').mockImplementation(() => {
      throw new Error('evaluator exploded');
    });

    const view = await getPlacement(rt, { placementId: 'pl_upsell', user: { id: 'u_free' } });
    expect(view.visible).toBe(false);
    expect(view.decision).toBeNull();
  });

  it('denies rather than granting when the remote transport is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const rt = createServerClient({
      tenantId: 'tn_test',
      transport: 'remote',
      endpoint: 'https://edge.example.com',
      apiToken: 'rtk_test',
    });

    const view = await getEntitlement(rt, 'brand_kit', { user: { id: 'u_pro' } });
    expect(view.denied).toBe(true);
    expect(view.allowed).toBe(false);
  });
});

describe('local mode needs no network (AC-20)', () => {
  it('resolves with fetch stubbed to reject', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('no network');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const rt = local();
    const granted = await getEntitlement(rt, 'brand_kit', {
      user: { id: 'u_pro', planHandle: 'pro' },
    });
    const denied = await getEntitlement(rt, 'brand_kit', {
      user: { id: 'u_free', planHandle: 'free' },
    });

    expect(granted.denied).toBe(false);
    expect(denied.denied).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves a placement decision with no network', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('no network');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const view = await getPlacement(local(), {
      placementId: 'pl_upsell',
      user: { id: 'u_free', planHandle: 'free' },
    });

    expect(view.placementId).toBe('pl_upsell');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Object.keys(view).sort()).toEqual(['content', 'decision', 'placementId', 'visible']);
  });
});
