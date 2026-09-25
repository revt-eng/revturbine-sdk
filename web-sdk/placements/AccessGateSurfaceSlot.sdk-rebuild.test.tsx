/**
 * @vitest-environment jsdom
 *
 * BL-0251 — a mounted `<Gate>` must survive the host publishing a NEW SDK
 * instance.
 *
 * `RevTurbineProvider` re-initializes whenever its `options` prop changes
 * identity, and publishes the replacement through context with `isReady` still
 * `true`. A host that derives options from an async session does exactly that,
 * once, shortly after first paint: revturbine-web's dogfood provider memoizes
 * them on the Better Auth session, so a hard refresh resolves the session after
 * the gate has already mounted.
 *
 * `useEntitlement` rebuilds its `EntitlementGate` on that change (its effect
 * keys on `sdk`) but the effect that RUNS the check keyed only on
 * `[autoCheck, isReady, handle, contextKey]` — none of which moved. The rebuilt
 * gate was therefore never checked, and an unchecked gate reports
 * `result === null` with `isLoading === false`, which `<Gate>` reads as
 * "unresolved" and renders as `null`. Every page whose whole body sits inside a
 * `<Gate>` went blank until it was remounted by navigating away and back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from '../react/useRevTurbine';
import { AccessGateSurfaceSlot as Gate } from './AccessGateSurfaceSlot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

/** A distinct SDK instance that grants — `label` makes the identity visible. */
function grantingSdk(label: string): AnySdk {
  return {
    label,
    getUserContext: vi.fn().mockReturnValue({ user_id: 'user_1' }),
    checkEntitlement: vi.fn().mockResolvedValue({ status: 'allowed', allowed: true }),
    emitPlatformEvent: vi.fn().mockResolvedValue(undefined),
    emitSemantic: vi.fn().mockResolvedValue(undefined),
    getPlacement: vi.fn().mockResolvedValue(null),
    getUsage: vi.fn().mockReturnValue({}),
    onUserContextChange: vi.fn().mockReturnValue(() => {}),
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

function tree(sdk: AnySdk): React.ReactElement {
  return (
    <RevTurbineContext.Provider value={{ sdk, isReady: true, error: '', setContext: () => {} }}>
      <Gate id="page-gate" can="event_explorer">
        <span data-testid="page-body">PAGE_BODY</span>
      </Gate>
    </RevTurbineContext.Provider>
  );
}

async function render(sdk: AnySdk): Promise<void> {
  await act(async () => root!.render(tree(sdk)));
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const body = () => container?.querySelector('[data-testid="page-body"]');

describe('<Gate> across an SDK instance change (BL-0251)', () => {
  it('renders the granted children on the first ready SDK', async () => {
    await render(grantingSdk('first'));
    expect(body()).not.toBeNull();
  });

  it('re-checks and keeps rendering when the provider publishes a new SDK', async () => {
    const first = grantingSdk('first');
    await render(first);
    expect(body(), 'children missing before the SDK changed').not.toBeNull();

    const second = grantingSdk('second');
    await render(second);

    expect(
      second.checkEntitlement,
      'the rebuilt gate was never checked against the new SDK instance',
    ).toHaveBeenCalled();
    expect(
      body(),
      'the gate parked as unresolved after the SDK instance changed — a page gated this way renders nothing until it is remounted',
    ).not.toBeNull();
  });
});
