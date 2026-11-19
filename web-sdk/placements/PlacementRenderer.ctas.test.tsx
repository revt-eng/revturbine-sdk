/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlacementRenderer } from './PlacementRenderer';
import { CtaResolverRegistry, bridgeUiPathResolversIntoRegistry, registerServerActionResolvers } from './cta-resolvers';
import type { PlacementCta, PlacementSlotProps } from './types';
import { PlacementTypeRegistry } from './registry';
import type { PlacementOutput, RevTurbineUiPathResolverMap } from '../customer-side';
import { RevTurbineCustomerSdk } from '../customer-side';
import { PlacementController } from '../controllers';
import { RevTurbineContext } from '../react/useRevTurbine';
import { INIT_STATUS_OK } from '../react/init-status';
import { useSurfaceSlot } from './useSurfaceSlot';
import { AccessGateSurfaceSlot } from './AccessGateSurfaceSlot';
import type { ServerActionMap } from './cta-resolvers';
import legacyConsumerSnapshot from '../../tests/parity/snapshots/placement_legacy_consumer_compat.ts.json';
import { PlacementDecisionOutputSchema, ContentUiPathSchema } from '@revt-eng/schema/zod';

const ctas: PlacementCta[] = [
  { label: 'Switch down', path: { type: 'downgrade', plan_handle: 'basic' }, role: 'downgrade', role_overridden: false, emphasis: 'secondary' },
  { label: 'Pause', path: { type: 'pause', months: 1 }, role: 'pause', role_overridden: true, emphasis: 'secondary' },
  { label: 'Keep my plan', path: { type: 'open_checkout', plan_handle: 'pro' }, role: 'purchase', role_overridden: false, emphasis: 'primary' },
  { label: 'Continue to cancel', path: { type: 'manage_subscription' }, role: 'continue', role_overridden: false, emphasis: 'link' },
  { label: 'Not now', path: { type: 'dismiss' }, role: 'not_now', role_overridden: false, emphasis: 'link' },
];
const placement: PlacementOutput = {
  output_id: 'cta-output', category: 'retention', surface: { type: 'modal', template: 'modal_overlay' },
  content: { header: 'Keep your plan', modal_type: 'Blocking', cta_label: 'Keep my plan', secondary_cta_label: 'Pause' },
  cta_path: ctas[2].path, ui_path: ctas[2].path, ctas,
  rule_id: 'retain', decision_id: 'cta-decision', config_version: 'v1', present_upsell: false,
};
let root: Root | undefined;
let container: HTMLDivElement;
let sdk: RevTurbineCustomerSdk | undefined;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  sdk?.dispose();
  sdk = undefined;
  vi.restoreAllMocks();
});
async function mount(node: React.ReactNode) {
  root = createRoot(container);
  await act(async () => root?.render(node));
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(el => el.textContent === label);
  expect(button, `CTA ${label} exists`).toBeDefined();
  await act(async () => button?.click());
}

function legacyGateRegistry() {
  const registry = new PlacementTypeRegistry();
  function LegacySlot({ content, uiPath, onCtaClick, onSecondaryCtaClick }: PlacementSlotProps) {
    return <><span data-testid="legacy-ui-path">{uiPath.type}</span>
      {content.cta_label && <button onClick={onCtaClick}>{content.cta_label}</button>}
      {content.secondary_cta_label && <button onClick={onSecondaryCtaClick}>{content.secondary_cta_label}</button>}</>;
  }
  registry.register({ id: 'modal_overlay', componentType: 'modal', label: 'Legacy gate renderer',
    description: 'Reads legacy labels and path, including registered content defaults.', component: LegacySlot,
    defaultProps: { content: { cta_label: 'Default primary', secondary_cta_label: 'Default secondary' } } });
  return registry;
}

describe('five CTA rendering and dispatch (ST-1425 AC-7/8/8b)', () => {
  it('shows primary first, secondaries next and text actions last, keeping original indices and Blocking exits', async () => {
    const fallback = vi.fn();
    const activate = vi.fn();
    await mount(<PlacementRenderer placement={placement} onCtaClick={fallback} onCtaActivate={activate} />);
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map(el => el.textContent)).toEqual(['Keep my plan', 'Switch down', 'Pause', 'Continue to cancel', 'Not now']);
    expect(container.querySelector('[aria-label="Close"]')).toBeNull();
    expect(buttons.map(el => el.dataset.rtEmphasis)).toEqual(['primary', 'secondary', 'secondary', 'link', 'link']);
    expect(buttons[3].dataset.rtRole).toBe('continue');
    await click('Continue to cancel');
    expect(activate).toHaveBeenCalledExactlyOnceWith(3);
    expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ type: 'manage_subscription' }));
  });

  it('adds full context to init resolvers and explicit registrations without changing legacy placement fields', async () => {
    const registry = new CtaResolverRegistry();
    const initResolver = vi.fn();
    bridgeUiPathResolversIntoRegistry({ open_checkout: initResolver }, registry);
    const explicit = vi.fn();
    registry.register('pause', explicit);
    await mount(<PlacementRenderer placement={placement} ctaResolvers={registry} />);
    await click('Keep my plan');
    expect(initResolver).toHaveBeenCalledWith(ctas[2].path, expect.objectContaining({
      index: 2, kind: 'primary', label: 'Keep my plan', path: ctas[2].path, role: 'purchase', role_overridden: false,
    }));
    await click('Pause');
    expect(explicit).toHaveBeenCalledWith(expect.objectContaining({ type: 'pause', params: { months: 1 } }), expect.objectContaining({
      index: 1, kind: 'secondary', label: 'Pause', role: 'pause', role_overridden: true,
      placement: expect.objectContaining({ cta_path: ctas[2].path }),
    }));
  });

  it('hides dismiss-role CTAs at a gate and preserves the remaining authored index', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const activate = vi.fn();
    await mount(<PlacementRenderer placement={{ ...placement, ctas: [
      { ...ctas[0], role: 'dismiss' }, ctas[1],
    ] }} excludeDismissCtas onCtaActivate={activate} />);
    expect(container.textContent).not.toContain('Switch down');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot render dismiss-role'));
    await click('Pause');
    expect(activate).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(['builtin', 'custom'])('projects allowed gate labels and path for a legacy %s renderer', async kind => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const activate = vi.fn();
    const fallback = vi.fn();
    const output: PlacementOutput = { ...placement,
      surface: kind === 'builtin' ? { type: 'button', template: 'button' } : placement.surface,
      content: { cta_label: 'Dismiss me', secondary_cta_label: 'View plans' },
      cta_path: { type: 'dismiss' }, ui_path: { type: 'dismiss' },
      ctas: [
        { label: 'Dismiss me', path: { type: 'dismiss' }, role: 'dismiss', role_overridden: false, emphasis: 'primary' },
        { label: 'View plans', path: { type: 'view_plans' }, role: 'learn_more', role_overridden: false, emphasis: 'secondary' },
      ] };
    await mount(<PlacementRenderer placement={output} excludeDismissCtas
      {...(kind === 'custom' ? { registry: legacyGateRegistry() } : {})}
      onCtaClick={fallback} onCtaActivate={activate} />);
    expect(Array.from(container.querySelectorAll('button')).map(button => button.textContent)).toEqual(['View plans']);
    if (kind === 'custom') expect(container.querySelector('[data-testid="legacy-ui-path"]')?.textContent).toBe('view_plans');
    await click('View plans');
    expect(activate).toHaveBeenCalledExactlyOnceWith(1);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'view_plans' }));
    expect(output.cta_path).toEqual({ type: 'dismiss' });
  });

  it.each(['builtin', 'custom'])('renders no legacy %s action when a gate filters every CTA', async kind => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const activate = vi.fn();
    const impression = vi.fn();
    const output: PlacementOutput = { ...placement,
      surface: kind === 'builtin' ? { type: 'button', template: 'button' } : placement.surface,
      content: { cta_label: 'Dismiss me' },
      ctas: [{ label: 'Dismiss me', path: { type: 'dismiss' }, role: 'dismiss', role_overridden: false, emphasis: 'primary' }] };
    await mount(<PlacementRenderer placement={output} excludeDismissCtas
      {...(kind === 'custom' ? { registry: legacyGateRegistry() } : {})}
      onCtaActivate={activate} onImpression={impression} fallback={<span>Access denied</span>} />);
    expect(container.textContent).toBe('Access denied');
    expect(container.querySelector('button')).toBeNull();
    expect(activate).not.toHaveBeenCalled();
    expect(impression).not.toHaveBeenCalled();
  });

  it('clears an excluded gate secondary label after registered defaults are merged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const activate = vi.fn();
    const output: PlacementOutput = { ...placement,
      content: { cta_label: 'Buy', secondary_cta_label: 'Dismiss me' },
      ctas: [
        { ...ctas[2], label: 'Buy' },
        { label: 'Dismiss me', path: { type: 'dismiss' }, role: 'dismiss', role_overridden: false, emphasis: 'secondary' },
        { label: 'View plans', path: { type: 'view_plans' }, role: 'learn_more', role_overridden: false, emphasis: 'secondary' },
      ] };
    await mount(<PlacementRenderer placement={output} excludeDismissCtas registry={legacyGateRegistry()}
      onCtaActivate={activate} />);
    expect(Array.from(container.querySelectorAll('button')).map(button => button.textContent)).toEqual(['Buy']);
    await click('Buy');
    expect(activate).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('renders the legacy two fields and keeps a 0.17-shaped resolver working', async () => {
    const registry = new CtaResolverRegistry();
    const legacy = vi.fn((_path, ctx) => [ctx.kind, ctx.placement.cta_path]);
    registry.register('open_checkout', legacy);
    const { ctas: _ctas, ...legacyPlacement } = placement;
    await mount(<PlacementRenderer placement={legacyPlacement} ctaResolvers={registry} />);
    expect(Array.from(container.querySelectorAll('button')).map(el => el.textContent)).toEqual(['Pause', 'Keep my plan']);
    await click('Keep my plan');
    expect(legacy.mock.results[0].value).toEqual(['primary', placement.cta_path]);
  });

  it('renders the actual legacy-consumer parity snapshot through its compatibility projection (AC-18)', async () => {
    const output = PlacementDecisionOutputSchema.parse(legacyConsumerSnapshot[0].result.output);
    const { ctas: _ctas, ...legacyOutput } = output;
    await mount(<PlacementRenderer placement={legacyOutput} />);
    expect(Array.from(container.querySelectorAll('button')).filter(el => el.textContent !== '×').map(el => el.textContent))
      .toEqual(['Second label', 'Primary third']);
    expect(output.cta_path).toEqual({ type: 'manage_subscription' });
    expect(output.ui_path).toEqual(output.cta_path);
  });
});

async function controllerFor(output: PlacementOutput, serverActions?: ServerActionMap, uiPathResolvers?: RevTurbineUiPathResolverMap) {
  sdk = new RevTurbineCustomerSdk({ user: { id: 'u_ctas' }, tenantId: 'tenant_ctas',
    serverActions, uiPathResolvers, anonymousTelemetry: false, runtimeMode: 'local_only', localRuntime: { playbook: {
      artifact_type: 'playbook', format_version: '1.0.0', playbook_handle: 'default',
      playbook_version_id: null, tenant_id: 'tenant_ctas', environment_id: 'production',
      plans: [], entitlements: [], entitlement_rules: [], segments: [], content_ui_paths: [], placements: [],
    } },
  });
  vi.spyOn(sdk, 'registerSurfaceSlot').mockResolvedValue('cta-placement');
  vi.spyOn(sdk, 'getPlacementDecision').mockResolvedValue({ placementId: 'cta-placement', visible: true,
    requestId: 'request-ctas', decisionSource: 'local', content: {}, output });
  const events = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
  const ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'cta-slot' } });
  await ctrl.load();
  events.mockClear();
  return { ctrl, events };
}

describe('CTA interactions use the one canonical event lane', () => {
  it.each([true, false])('keeps the actual gate denial fallback when every CTA is excluded (custom=%s)', async custom => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const output: PlacementOutput = { ...placement,
      surface: { type: 'button', template: 'button' },
      content: { cta_label: 'Dismiss me' },
      ctas: [{ label: 'Dismiss me', path: { type: 'dismiss' }, role: 'dismiss', role_overridden: false, emphasis: 'primary' }] };
    await controllerFor(output);
    if (!sdk) throw new Error('SDK was not constructed');
    vi.spyOn(sdk, 'checkEntitlement').mockResolvedValue({ status: 'denied', allowed: false, reason: 'test_denied' });
    await mount(<RevTurbineContext.Provider value={{ sdk, isReady: true, error: '',
      initStatus: INIT_STATUS_OK, colorScheme: 'light', setContext: () => {} }}>
      <AccessGateSurfaceSlot id="cta-gate" can="paid_feature" surfaceTemplateIds={['button']}
        {...(custom ? { deniedFallback: <span>Custom access denied</span> } : {})}>
        <span>Paid feature</span>
      </AccessGateSurfaceSlot>
    </RevTurbineContext.Provider>);
    await vi.waitFor(() => {
      if (custom) expect(container.textContent).toContain('Custom access denied');
      else expect(container.querySelector('[data-rt-access-denied]')).not.toBeNull();
    });
    expect(container.textContent).not.toContain('Dismiss me');
    expect(container.textContent).not.toContain('Paid feature');
    expect(container.querySelector('button')).toBeNull();
  });

  it.each(['builtin', 'custom'])('attributes legacy %s slot callbacks to the primary authored third and secondary authored second', async kind => {
    const output: PlacementOutput = { ...placement, surface: kind === 'builtin' ? { type: 'button', template: 'button' } : placement.surface };
    const { events } = await controllerFor(output);
    const fallback = vi.fn();
    const registry = new PlacementTypeRegistry();
    function LegacySlot({ content, onCtaClick, onSecondaryCtaClick }: PlacementSlotProps) {
      return <><button onClick={onCtaClick}>{content.cta_label}</button>
        <button onClick={onSecondaryCtaClick}>{content.secondary_cta_label}</button></>;
    }
    registry.register({ id: 'modal_overlay', componentType: 'modal', label: 'Legacy renderer',
      description: 'Uses the unchanged primary and secondary callback props.', component: LegacySlot });
    function Surface() {
      const { element } = useSurfaceSlot({ surfaceSlot: { id: 'cta-slot' },
        ...(kind === 'custom' ? { registry } : {}), onCtaClick: fallback });
      return element;
    }
    await mount(<RevTurbineContext.Provider value={{ sdk: sdk ?? null, isReady: true, error: '',
      initStatus: INIT_STATUS_OK, colorScheme: 'light', setContext: () => {} }}><Surface /></RevTurbineContext.Provider>);
    await vi.waitFor(() => expect(container.textContent).toContain('Keep my plan'));
    events.mockClear();
    await click('Keep my plan');
    expect(events.mock.calls.filter(([name]) => name === 'placement_interaction')).toHaveLength(1);
    expect(events.mock.calls.find(([name]) => name === 'placement_interaction')?.[1]).toMatchObject({
      cta_index: 2, cta_label: 'Keep my plan', cta_target: 'open_checkout', cta_role: 'purchase',
    });
    expect(fallback).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'open_checkout' }));
    if (kind === 'custom') {
      events.mockClear();
      await click('Pause');
      expect(events.mock.calls.filter(([name]) => name === 'placement_interaction')).toHaveLength(1);
      expect(events.mock.calls.find(([name]) => name === 'placement_interaction')?.[1]).toMatchObject({
        cta_index: 1, cta_label: 'Pause', cta_target: 'pause', cta_role: 'pause', cta_role_overridden: true,
      });
      expect(fallback).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'pause', params: { months: 1 } }));
    }
  });

  it('records an indexed built-in snooze once, with CTA identity and its authored reminder window', async () => {
    const output = { ...placement, remind_later_minutes: 45,
      ctas: [{ ...ctas[0], label: 'Remind me', path: { type: 'snooze' }, role: 'not_now' }] };
    const { events } = await controllerFor(output);
    const record = sdk ? vi.spyOn(sdk, 'trackTreatmentInteraction') : undefined;
    function Surface() {
      const { element } = useSurfaceSlot({ surfaceSlot: { id: 'cta-slot' } });
      return element;
    }
    await mount(<RevTurbineContext.Provider value={{ sdk: sdk ?? null, isReady: true, error: '',
      initStatus: INIT_STATUS_OK, colorScheme: 'light', setContext: () => {} }}><Surface /></RevTurbineContext.Provider>);
    await vi.waitFor(() => expect(container.textContent).toContain('Remind me'));
    events.mockClear(); record?.mockClear();
    await click('Remind me');
    expect(container.textContent).not.toContain('Remind me');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ interactionType: 'remind_me_later',
      metadata: expect.objectContaining({ remind_after_seconds: 2700, cta_index: 0 }) }));
    const interactions = events.mock.calls.filter(([name]) => name === 'placement_interaction');
    expect(interactions).toHaveLength(1);
    expect(interactions[0][1]).toMatchObject({ interaction_type: 'remind_me_later', cta_index: 0,
      cta_label: 'Remind me', cta_target: 'snooze', cta_role: 'not_now', cta_role_overridden: false });
  });

  it('threads SDK-init uiPathResolvers through the surface hook and keeps role enrichment neutral for coverage', async () => {
    const resolver = vi.fn();
    const { events } = await controllerFor(placement, undefined, { open_checkout: resolver });
    const legacyPath = ContentUiPathSchema.parse({ name: 'checkout', action_type: 'open_checkout_modal', config: {} });
    const before = await sdk?.validateUiPathResolvers({ uiPaths: [legacyPath] });
    const after = await sdk?.validateUiPathResolvers({ uiPaths: [{ ...legacyPath, role: 'purchase' }] });
    expect(before?.valid).toBe(true);
    expect(after).toEqual(before);
    function Surface() {
      const { element } = useSurfaceSlot({ surfaceSlot: { id: 'cta-slot' } });
      return element;
    }
    await mount(<RevTurbineContext.Provider value={{ sdk: sdk ?? null, isReady: true, error: '',
      initStatus: INIT_STATUS_OK, colorScheme: 'light', setContext: () => {} }}><Surface /></RevTurbineContext.Provider>);
    await vi.waitFor(() => expect(container.textContent).toContain('Keep my plan'));
    events.mockClear();
    await click('Keep my plan');
    expect(resolver).toHaveBeenCalledWith(ctas[2].path, expect.objectContaining({ index: 2,
      kind: 'primary', label: ctas[2].label, path: ctas[2].path, role: 'purchase', role_overridden: false }));
    expect(events.mock.calls.filter(([name]) => name === 'placement_interaction')).toHaveLength(1);
  });
  it.each([true, false])('threads real init serverActions through the surface hook exactly once (success=%s)', async success => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const action = vi.fn(async () => ({ success }));
    const { events } = await controllerFor(placement, { pause: action });
    const fallback = vi.fn();
    function Surface() {
      const { element } = useSurfaceSlot({ surfaceSlot: { id: 'cta-slot' }, onCtaClick: fallback });
      return element;
    }
    await mount(<RevTurbineContext.Provider value={{ sdk: sdk ?? null, isReady: true, error: '',
      initStatus: INIT_STATUS_OK, colorScheme: 'light', setContext: () => {} }}><Surface /></RevTurbineContext.Provider>);
    await vi.waitFor(() => expect(container.textContent).toContain('Pause'));
    events.mockClear();
    await click('Pause');
    await vi.waitFor(() => expect(events.mock.calls.filter(([name]) => name === 'placement_interaction')).toHaveLength(1));
    const interactions = events.mock.calls.filter(([name]) => name === 'placement_interaction');
    expect(interactions[0][1]).toMatchObject({ interaction_type: 'cta_clicked', cta_index: 1,
      cta_label: 'Pause', cta_target: 'pause', cta_role: 'pause', cta_role_overridden: true,
      action_type: 'pause', action_success: success, action_outcome: success ? 'success' : 'failure' });
    expect(action).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });
  it('records a registered resolver click once, preserving all five fields and keeping the placement visible', async () => {
    const { ctrl, events } = await controllerFor(placement);
    const registry = new CtaResolverRegistry();
    const resolver = vi.fn();
    registry.register('pause', resolver);
    await mount(<PlacementRenderer placement={placement} ctaResolvers={registry}
      onCtaActivate={index => { void ctrl.ctaClick(index); }} />);
    await click('Pause');
    const interactions = events.mock.calls.filter(([name]) => name === 'placement_interaction');
    expect(interactions).toHaveLength(1);
    expect(interactions[0][1]).toMatchObject({ interaction_type: 'cta_clicked', cta_index: 1,
      cta_label: 'Pause', cta_target: 'pause', cta_role: 'pause', cta_role_overridden: true });
    expect(resolver).toHaveBeenCalledOnce();
    expect(ctrl.visible).toBe(true);
  });

  it.each([true, false])('records one server-action event with CTA identity and result facts (success=%s)', async success => {
    const { ctrl, events } = await controllerFor(placement);
    const registry = new CtaResolverRegistry();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerServerActionResolvers({ pause: async () => ({ success }) }, {
      applyUserContext: vi.fn(),
      trackResult: (ctx, ok) => ctx.cta?.recordInteraction?.({ action_type: ctx.actionType,
        action_success: ok, action_outcome: ok ? 'success' : 'failure' }),
    }, registry);
    await mount(<PlacementRenderer placement={placement} ctaResolvers={registry}
      onCtaActivate={(index, metadata) => { void ctrl.ctaClick(index, metadata); }} />);
    await click('Pause');
    const interactions = events.mock.calls.filter(([name]) => name === 'placement_interaction');
    expect(interactions).toHaveLength(1);
    expect(interactions[0][1]).toMatchObject({ cta_index: 1, cta_role: 'pause', cta_role_overridden: true,
      action_type: 'pause', action_success: success, action_outcome: success ? 'success' : 'failure' });
    error.mockRestore();
  });

  it('dismisses for a dismiss path or role, while an X dismissal has no CTA fields', async () => {
    const { ctrl, events } = await controllerFor(placement);
    await ctrl.ctaClick(4);
    expect(ctrl.visible).toBe(false);
    expect(events.mock.calls.find(([name]) => name === 'placement_interaction')?.[1]).toMatchObject({
      interaction_type: 'dismiss', cta_index: 4, cta_target: 'dismiss', cta_role: 'not_now',
    });
    await ctrl.load(); events.mockClear();
    await ctrl.dismiss();
    const event = events.mock.calls.find(([name]) => name === 'placement_interaction')?.[1];
    expect(event).toMatchObject({ interaction_type: 'dismiss' });
    expect(event).not.toHaveProperty('cta_index');
    expect(event).not.toHaveProperty('cta_role');
  });

  it('records role dismissal once and still dispatches the button own non-dismiss path', async () => {
    const banner: PlacementOutput = { ...placement, surface: { type: 'banner' }, ctas: [{ ...ctas[0], role: 'dismiss' }] };
    const { ctrl, events } = await controllerFor(banner);
    const navigate = vi.fn();
    await mount(<PlacementRenderer placement={banner} onCtaClick={navigate}
      onCtaActivate={index => { void ctrl.ctaClick(index); }} />);
    await click('Switch down');
    expect(ctrl.visible).toBe(false);
    expect(events.mock.calls.filter(([name]) => name === 'placement_interaction')).toHaveLength(1);
    expect(events.mock.calls.find(([name]) => name === 'placement_interaction')?.[1]).toMatchObject({
      interaction_type: 'dismiss', cta_index: 0, cta_target: 'downgrade', cta_role: 'dismiss',
    });
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ type: 'downgrade', plan_handle: 'basic' }));
  });
});
