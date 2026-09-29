/**
 * @vitest-environment jsdom
 *
 * The provider must not trip the plan 191 unrecognized-key guardrail on its
 * own wiring.
 *
 * `options.user.id` is how the provider learns WHICH user to identify — it is
 * identify()'s first argument, not an identify-context key. The provider used
 * to forward the whole `user` object as the context too, so every mount of a
 * correctly-integrated app logged "dropped unrecognized user-context key(s):
 * id" and captured an `sdk_validation_warning` event. Observed live on the
 * dogfood tenant 2026-08-26 (five events, one per session, zero integration
 * mistakes behind them).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { useRevTurbine } from './useRevTurbine';
import type { RevTurbineInitOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const handle: { isReady: boolean } = { isReady: false };

function Probe(): null {
  handle.isReady = useRevTurbine().isReady;
  return null;
}

async function mount(options: RevTurbineInitOptions): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={options}>
        <Probe />
      </RevTurbineProvider>,
    );
  });
}

describe('RevTurbineProvider identify context (options.user.id)', () => {
  it('does not report `id` as an unrecognized user-context key', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount({
      tenantId: 'tenant_identify_ctx',
      apiKey: 'sk_test',
      publicKey: 'pub_test',
      environmentId: 'staging',
      endpoint: 'https://edge.example.com',
      mode: 'react',
      runtimeMode: 'local_only',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      user: { id: 'user_123', plan: { handle: 'free', name: 'Free' } },
    } as RevTurbineInitOptions);

    expect(handle.isReady).toBe(true);
    const unrecognized = consoleWarn.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('unrecognized user-context key'));
    expect(unrecognized).toEqual([]);
  });
});

describe('RevTurbineProvider identify context — session fields (BL-0403)', () => {
  const base = {
    tenantId: 'tenant_identify_ctx',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'react',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  } as const;

  it('does not report trial / tiers / billing / instances / experiments as dropped, and keeps them', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let sdkRef: ReturnType<typeof useRevTurbine>['sdk'] = null;
    function SdkProbe(): null {
      sdkRef = useRevTurbine().sdk;
      return null;
    }
    const trial = { in_trial: true, trial_limit_type: 'time' as const, day_number: 12, days_remaining: 2 };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RevTurbineProvider
          options={{
            ...base,
            user: {
              id: 'user_123',
              plan_handle: 'free',
              email_type: 'business',
              trial,
              tiers: { storage: 'tier_2' },
              payment_failed: false,
              payment_at_risk: true,
              instances: [],
              experiments: { exp_pricing: 'variant_b' },
            },
          } as RevTurbineInitOptions}
        >
          <SdkProbe />
        </RevTurbineProvider>,
      );
    });

    const dropped = consoleWarn.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('unrecognized user-context key'));
    expect(dropped).toEqual([]);
    const held = await sdkRef!.getEffectiveUserContext();
    expect(held.trial).toEqual(trial);
    expect(await sdkRef!.getTrialStatus()).toEqual(trial);
    expect(held.tiers).toEqual({ storage: 'tier_2' });
    expect(held.payment_at_risk).toBe(true);
    expect(held.experiments).toEqual({ exp_pricing: 'variant_b' });
  });

  it('still reports a genuinely unknown key', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount({
      ...base,
      user: { id: 'user_123', plan_handle: 'free', not_a_context_key: 1 },
    } as unknown as RevTurbineInitOptions);
    const dropped = consoleWarn.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('unrecognized user-context key'));
    expect(dropped.join(' ')).toContain('not_a_context_key');
  });
});
