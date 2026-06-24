import { describe, expect, it, vi } from 'vitest';
import { parseUiPath } from './registry';
import {
  CtaResolverRegistry,
  dispatchCtaClick,
  getDefaultCtaResolverRegistry,
  registerCtaResolver,
  resetDefaultCtaResolverRegistry,
  unregisterCtaResolver,
} from './cta-resolvers';
import type { CtaResolverContext, PlacementUiPath } from './types';
import type { PlacementOutput } from '../customer-side';

const placement: PlacementOutput = {
  output_id: 'out_1',
  category: 'fixed',
  surface: { template: 'modal_overlay', type: 'modal', slot_id: 'slot_1' },
  content: {},
  cta_path: {},
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: true,
};

describe('parseUiPath — custom CTA params passthrough', () => {
  it('preserves a tenant custom action name and collects non-whitelisted keys into params', () => {
    expect(parseUiPath({ type: 'custom', url: '/integrations/crm', org: '42' })).toEqual({
      type: 'custom',
      url: '/integrations/crm',
      params: { org: '42' },
    });
  });

  it('preserves an arbitrary custom action name verbatim', () => {
    expect(parseUiPath({ type: 'connect_crm', workspace: 'acme' })).toEqual({
      type: 'connect_crm',
      params: { workspace: 'acme' },
    });
  });

  it('lifts known fields onto typed properties and keeps them out of params', () => {
    expect(parseUiPath({ type: 'open_checkout_modal', plan_handle: 'pro', source: 'banner' })).toEqual({
      type: 'open_checkout_modal',
      plan_handle: 'pro',
      params: { source: 'banner' },
    });
  });

  it('omits params when a known action carries no extra keys', () => {
    const result = parseUiPath({ type: 'navigate_to_plans' });
    expect(result).toEqual({ type: 'navigate_to_plans' });
    expect('params' in result).toBe(false);
  });

  it('defaults to dismiss when type is absent or non-string', () => {
    expect(parseUiPath({}).type).toBe('dismiss');
    expect(parseUiPath({ type: 123 }).type).toBe('dismiss');
    expect(parseUiPath({ type: '' }).type).toBe('dismiss');
  });
});

describe('CtaResolverRegistry', () => {
  it('registers and looks up a resolver by action type', () => {
    const registry = new CtaResolverRegistry();
    const resolver = vi.fn();
    registry.register('connect_crm', resolver);
    expect(registry.has('connect_crm')).toBe(true);
    expect(registry.get('connect_crm')).toBe(resolver);
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('replaces and warns when re-registering the same action type', () => {
    const registry = new CtaResolverRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = vi.fn();
    const second = vi.fn();
    registry.register('connect_crm', first);
    registry.register('connect_crm', second);
    expect(registry.get('connect_crm')).toBe(second);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('unregister removes a resolver and reports whether one existed', () => {
    const registry = new CtaResolverRegistry();
    registry.register('connect_crm', vi.fn());
    expect(registry.unregister('connect_crm')).toBe(true);
    expect(registry.has('connect_crm')).toBe(false);
    expect(registry.unregister('connect_crm')).toBe(false);
  });

  it('clear empties the registry', () => {
    const registry = new CtaResolverRegistry();
    registry.register('a', vi.fn());
    registry.register('b', vi.fn());
    registry.clear();
    expect(registry.has('a')).toBe(false);
    expect(registry.has('b')).toBe(false);
  });
});

describe('dispatchCtaClick', () => {
  const uiPath: PlacementUiPath = { type: 'connect_crm', url: '/x', params: { org: '42' } };
  const context: CtaResolverContext = { placement, kind: 'primary' };

  it('invokes the registered resolver with the uiPath + context and skips the fallback', () => {
    const registry = new CtaResolverRegistry();
    const resolver = vi.fn();
    const fallback = vi.fn();
    registry.register('connect_crm', resolver);

    const handled = dispatchCtaClick(uiPath, context, registry, fallback);

    expect(handled).toBe(true);
    expect(resolver).toHaveBeenCalledWith(uiPath, context);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to the callback when no resolver is registered', () => {
    const registry = new CtaResolverRegistry();
    const fallback = vi.fn();

    const handled = dispatchCtaClick(uiPath, context, registry, fallback);

    expect(handled).toBe(false);
    expect(fallback).toHaveBeenCalledWith(uiPath);
  });

  it('does not throw when neither a resolver nor a fallback is provided', () => {
    const registry = new CtaResolverRegistry();
    expect(dispatchCtaClick(uiPath, context, registry)).toBe(false);
  });
});

describe('default CTA resolver registry', () => {
  it('registerCtaResolver targets the default registry; reset clears it', () => {
    resetDefaultCtaResolverRegistry();
    const resolver = vi.fn();
    registerCtaResolver('connect_crm', resolver);
    expect(getDefaultCtaResolverRegistry().get('connect_crm')).toBe(resolver);

    expect(unregisterCtaResolver('connect_crm')).toBe(true);
    expect(getDefaultCtaResolverRegistry().has('connect_crm')).toBe(false);

    registerCtaResolver('connect_crm', resolver);
    resetDefaultCtaResolverRegistry();
    expect(getDefaultCtaResolverRegistry().has('connect_crm')).toBe(false);
  });
});
