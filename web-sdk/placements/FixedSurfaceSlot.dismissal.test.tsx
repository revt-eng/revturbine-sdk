/**
 * @vitest-environment jsdom
 *
 * Plan 233 TASK-9 / AC-11 — a dismissal is not a no-match.
 *
 * `FixedSurfaceSlot` rendered `fallback` whenever `!visible`, and dismissing
 * sets `visible: false`. So the instant a user closed the placement, the slot
 * put the fallback content back in the same space — a "ghost" replacing the
 * thing just dismissed. The escalated integration needed three attempts and a
 * MutationObserver to suppress it.
 *
 * Two outcomes share one `visible: false` and want opposite UI:
 *   no match   → show the fallback (the slot is "always present" by design)
 *   dismissed  → show nothing (the user closed it)
 *
 * A second defect found while implementing: `onDismissed` existed on
 * `MessageSurfaceSlot` as a prop but never fired — its handler was built and
 * then discarded with `void handleDismissWrap`. Both slots now route through
 * one wired implementation in `useSurfaceSlot`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FixedSurfaceSlot } from './FixedSurfaceSlot';
import { RevTurbineProvider } from '../react/RevTurbineProvider';
import type { RevTurbineInitInputOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const SLOT_ID = 'slot_upgrade';
const PLACEMENT_ID = 'pl_upgrade';

const PLAYBOOK = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  tenant_id: 't_1',
  environment_id: 'production',
  plans: [],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
  placements: [
    {
      id: PLACEMENT_ID,
      name: SLOT_ID,
      category: 'upsell',
      payloads: [
        {
          id: 'payload_1',
          target: { plan_ids: [], segment_chips: [] },
          surfaces: [
            {
              template_id: 'banner_placement',
              fields: { header: 'Upgrade', body: 'More features' },
              ctas: [{ label: 'Upgrade', path: 'open_checkout', config: {} }],
            },
          ],
        },
      ],
    },
  ],
};

const OPTIONS = {
  tenantId: 't_1',
  runtimeMode: 'local_only',
  localRuntime: { playbook: PLAYBOOK },
} as unknown as RevTurbineInitInputOptions;

/** No placements at all — the only way to guarantee a no-match. */
const EMPTY_OPTIONS = {
  tenantId: 't_1',
  runtimeMode: 'local_only',
  localRuntime: { playbook: { ...PLAYBOOK, placements: [] } },
} as unknown as RevTurbineInitInputOptions;

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('AC-11 — dismissal renders neither the placement nor the fallback', () => {
  it('renders the fallback when no placement matches', async () => {
    // The behaviour that must be preserved: a fixed slot is "always present",
    // so nothing-matched still fills the space.
    await mount(
      <RevTurbineProvider options={EMPTY_OPTIONS}>
        <FixedSurfaceSlot id="slot_nothing_matches" fallback={<span>FALLBACK</span>} />
      </RevTurbineProvider>,
    );

    expect(container?.textContent).toContain('FALLBACK');
  });

  it('renders neither the placement nor the fallback after a dismissal', async () => {
    const seen: Array<'dismissed'> = [];

    await mount(
      <RevTurbineProvider options={OPTIONS}>
        <FixedSurfaceSlot
          id={SLOT_ID}
          fallback={<span>FALLBACK</span>}
          onDismissed={() => seen.push('dismissed')}
        />
      </RevTurbineProvider>,
    );

    // Assert the control EXISTS before clicking it. A `if (button) { … }` here
    // would pass vacuously the day the affordance moves, which is the failure
    // shape this whole plan is about.
    const dismissButton = container?.querySelector('[aria-label="Dismiss"]');
    expect(dismissButton).not.toBeNull();
    expect(container?.textContent).toContain('Upgrade');

    await act(async () => {
      (dismissButton as HTMLElement).click();
    });

    // The whole point: the space stays EMPTY. Before plan 233 this rendered
    // 'FALLBACK', because `!visible` and "no match" were the same branch.
    expect(container?.textContent).not.toContain('FALLBACK');
    expect(container?.textContent).not.toContain('Upgrade');
    expect(seen).toEqual(['dismissed']);
  });
});

// NOTE: there is deliberately no runtime test asserting that `onDismissed`
// EXISTS as a prop. JSX props are a plain object, so `element.props.onDismissed`
// is truthy whether or not the component declares it — such a test passes
// identically on the broken code and proves nothing. The prop's existence is
// enforced by the typecheck of this file; its BEHAVIOUR is covered above, by
// clicking a real dismiss control and observing the callback fire.
