import { describe, expect, it } from 'vitest';
import type { PlacementOutput } from '../customer-side';
import { registerBuiltinSlotTypes, COMPONENT_FIELD_CONTRACTS } from './builtin';
import { PlacementTypeRegistry } from './registry';

function output(type: PlacementOutput['surface']['type'], template: string): PlacementOutput {
  return {
    output_id: `out_${template}`,
    rule_id: 'rule_1',
    decision_id: 'decision_1',
    config_version: 'v1',
    category: 'fixed',
    surface: { type, template },
    content: {},
    cta_path: {},
    present_upsell: false,
  };
}

describe('ComponentType registry', () => {
  it('renders a non-seed modal template through the canonical modal component', () => {
    const registry = new PlacementTypeRegistry();
    registerBuiltinSlotTypes(registry);

    expect(registry.resolve(output('modal', 'customer_modal'))?.id).toBe('modal');
  });

  it('narrows two templates sharing one component type without changing the type index', () => {
    const registry = new PlacementTypeRegistry();
    registry.register({
      id: 'optional_modal',
      label: 'Optional modal',
      description: 'Optional variant',
      componentType: 'modal',
      component: () => null,
      accepts: (candidate) => candidate.surface.template === 'modal_optional',
      priority: 10,
    });
    registry.register({
      id: 'blocking_modal',
      label: 'Blocking modal',
      description: 'Blocking variant',
      componentType: 'modal',
      component: () => null,
      accepts: (candidate) => candidate.surface.template === 'modal_blocking',
      priority: 10,
    });

    expect(registry.resolve(output('modal', 'modal_optional'))?.id).toBe('optional_modal');
    expect(registry.resolve(output('modal', 'modal_blocking'))?.id).toBe('blocking_modal');
  });

  it('keeps subtype matching exact', () => {
    const registry = new PlacementTypeRegistry();
    registerBuiltinSlotTypes(registry);

    expect(registry.resolve(output('tooltip', 'tooltip'))?.id).toBe('tooltip');
    expect(registry.listByComponentType('in_page').map((entry) => entry.id)).not.toContain('tooltip');
  });

  it('publishes non-empty machine-readable field contracts for every built-in component', () => {
    expect(Object.values(COMPONENT_FIELD_CONTRACTS).every((fields) => fields.length > 0)).toBe(true);
    const registry = new PlacementTypeRegistry();
    registerBuiltinSlotTypes(registry);
    expect(registry.listAll().every((entry) => entry.renderedFields.length > 0)).toBe(true);
  });

  it('keeps surfaceType as a deprecated registration alias', () => {
    const registry = new PlacementTypeRegistry();
    registry.register({
      id: 'legacy_banner',
      label: 'Legacy banner',
      description: 'Compatibility fixture',
      surfaceType: 'banner',
      component: () => null,
    });
    expect(registry.get('legacy_banner')?.componentType).toBe('banner');
  });
});
