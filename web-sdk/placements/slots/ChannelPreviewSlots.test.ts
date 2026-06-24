import { describe, expect, it } from 'vitest';
import type { PlacementOutput } from '../../customer-side';
import {
  getDefaultRegistry,
  resetDefaultRegistry,
} from '../registry';
import { orderedChannelCtas } from './ChannelPreviewSlots';

/** Minimal placement output — `resolve()` only reads `surface.type`/`template`. */
function outputForSurface(type: string): PlacementOutput {
  return { surface: { type } } as unknown as PlacementOutput;
}

describe('channel preview slot registration (plan 76 TASK-15, AC-11)', () => {
  it('resolves a slot for email/sms/push surface types (previously a silent no-op)', () => {
    resetDefaultRegistry();
    const registry = getDefaultRegistry();

    for (const [surfaceType, expectedId] of [
      ['email', 'email'],
      ['sms', 'sms'],
      ['push', 'push'],
    ] as const) {
      const slot = registry.resolve(outputForSurface(surfaceType));
      expect(slot, `no slot registered for ${surfaceType}`).toBeDefined();
      expect(slot?.id).toBe(expectedId);
      expect(slot?.surfaceType).toBe(surfaceType);
      expect(typeof slot?.component).toBe('function');
    }
  });

  it('keeps the channel slots listed under their surface type', () => {
    resetDefaultRegistry();
    const registry = getDefaultRegistry();
    expect(registry.listBySurfaceType('email').map((t) => t.id)).toContain('email');
    expect(registry.listBySurfaceType('sms').map((t) => t.id)).toContain('sms');
    expect(registry.listBySurfaceType('push').map((t) => t.id)).toContain('push');
  });
});

describe('orderedChannelCtas (plan 76 TASK-15, AC-12 — first CTA is primary)', () => {
  it('returns primary before secondary', () => {
    const ctas = orderedChannelCtas({ cta_label: 'Upgrade', secondary_cta_label: 'Later' });
    expect(ctas).toEqual([
      { kind: 'primary', label: 'Upgrade' },
      { kind: 'secondary', label: 'Later' },
    ]);
  });

  it('drops absent labels', () => {
    expect(orderedChannelCtas({ cta_label: 'Only primary' })).toEqual([
      { kind: 'primary', label: 'Only primary' },
    ]);
    expect(orderedChannelCtas({ secondary_cta_label: 'Only secondary' })).toEqual([
      { kind: 'secondary', label: 'Only secondary' },
    ]);
    expect(orderedChannelCtas({})).toEqual([]);
  });
});
