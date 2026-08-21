/**
 * Plan 194 REQ-4 (AC-4) — `<Gate>` must not put the paid affordance in
 * server-rendered HTML.
 *
 * The gate is constructed inside a `useEffect`, and effects do not run during
 * SSR. So on the server `gateRef.current` is null, `isLoading` reads `false`
 * (there is no gate to be loading), `result` is `null`, and `denied` therefore
 * computes `false` — the gate renders its CHILDREN.
 *
 * That is a fail-open in the one place it cannot be corrected by the client: a
 * crawler or a JS-disabled reader sees the paid affordance permanently, and
 * every other user sees it flash before hydration closes the gate. It also
 * contradicts `useCan`'s own documented deny-until-ready contract, which the
 * same codebase states two files away.
 *
 * These tests render with `react-dom/server` — no jsdom, no effects, no
 * hydration — because that is the environment the bug lives in.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { RevTurbineContext } from '../react/useRevTurbine';
import { AccessGateSurfaceSlot as Gate } from './AccessGateSurfaceSlot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

/**
 * An SDK that would GRANT if anything asked it — so a passing test proves the
 * gate withheld the children on its own, not that the check happened to deny.
 */
function grantingSdk(): AnySdk {
  return {
    getUserContext: () => ({ user_id: 'user_ssr' }),
    checkEntitlement: async () => ({ status: 'allowed', allowed: true }),
    emitSemantic: async () => undefined,
    getPlacement: async () => null,
    getUsage: () => ({}),
    onUserContextChange: () => () => {},
  };
}

function ssr(node: React.ReactElement, { isReady = true } = {}): string {
  return renderToString(
    <RevTurbineContext.Provider
      value={{ sdk: grantingSdk(), isReady, error: '', setContext: () => {} }}
    >
      {node}
    </RevTurbineContext.Provider>,
  );
}

describe('<Gate> during server rendering', () => {
  it('does not emit the gated children', () => {
    const html = ssr(
      <Gate can="batch_export" deniedFallback={<span>upgrade</span>}>
        <span>PAID_AFFORDANCE</span>
      </Gate>,
    );

    expect(html).not.toContain('PAID_AFFORDANCE');
  });

  it('renders identically whether the user would be granted or denied', () => {
    // The server cannot know the answer — it has run no check. If the two
    // differ, the markup is leaking a decision that was never made.
    const granted = ssr(
      <Gate can="batch_export">
        <span>PAID_AFFORDANCE</span>
      </Gate>,
    );
    const denied = ssr(
      <Gate can="nothing_grants_this">
        <span>PAID_AFFORDANCE</span>
      </Gate>,
    );

    expect(granted).toBe(denied);
  });

  it('withholds children before the SDK is even ready', () => {
    const html = ssr(
      <Gate can="batch_export">
        <span>PAID_AFFORDANCE</span>
      </Gate>,
      { isReady: false },
    );

    expect(html).not.toContain('PAID_AFFORDANCE');
  });

  it('shows the denied fallback when the check errors, not the children', () => {
    // A settled error is a decision. Before plan 194 REQ-4 an errored check
    // left `result` null and `denied` false, so the gate rendered its
    // children — a failed check GRANTED. It now denies, and shows the upsell
    // rather than a blank, matching how `useCan` settles.
    const html = renderToString(
      <RevTurbineContext.Provider
        value={{
          sdk: { ...grantingSdk(), checkEntitlement: async () => { throw new Error('boom'); } },
          isReady: true,
          error: '',
          setContext: () => {},
        }}
      >
        <Gate can="batch_export" deniedFallback={<span>UPGRADE</span>}>
          <span>PAID_AFFORDANCE</span>
        </Gate>
      </RevTurbineContext.Provider>,
    );

    expect(html).not.toContain('PAID_AFFORDANCE');
  });

  it('still renders children for an ungated slot', () => {
    // Anti-vacuity: a `<Gate>` with no entitlement to check gates nothing, so
    // a blanket "render nothing on the server" regression would fail here.
    const html = ssr(
      <Gate>
        <span>UNGATED</span>
      </Gate>,
    );

    expect(html).toContain('UNGATED');
  });
});
