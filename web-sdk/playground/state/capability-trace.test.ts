import { describe, expect, it } from 'vitest';
import { ExportedConfigSchema } from '@revt-eng/schema';
import rawConfig from '../config/prism-export-config.json';
import { traceFor } from './capability-trace';

const PRISM_CONFIG = ExportedConfigSchema.parse(rawConfig);

/**
 * Plan 81 TASK-7 / AC-7: every placement the playground can render must carry a
 * decision trace, so no surface ships without an explanation. Surface-render
 * placements are traced by their slot id (how the playground mounts them); all
 * others by their placement id.
 */
describe('capability decision trace', () => {
  it('covers every placement in the Prism config', () => {
    for (const p of PRISM_CONFIG.placements ?? []) {
      const key = p.trigger.type === 'surface_render' ? p.trigger.slot_id : p.id;
      expect(traceFor(key), `no decision trace for "${key}" (${p.name})`).not.toBeNull();
    }
  });

  it('returns a capability, why, and spec for a known surface', () => {
    const trace = traceFor('pl_reverse_trial');
    expect(trace?.capability).toMatch(/reverse trial/i);
    expect(trace?.why.length).toBeGreaterThan(0);
    expect(trace?.spec.length).toBeGreaterThan(0);
  });

  it('returns null for an unknown key', () => {
    expect(traceFor('nope')).toBeNull();
  });
});
