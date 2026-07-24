/**
 * Plan 144 — the `RuntimeMode` typed enum. Consumers reference these constants
 * instead of raw string literals when setting `runtimeMode` (e.g. demos use
 * `RuntimeMode.LocalOnly` so they never emit telemetry).
 */
import { describe, expect, it } from 'vitest';
import { RuntimeMode } from './customer-side';
import type { RevTurbineRuntimeMode } from './customer-side';

describe('RuntimeMode', () => {
  it('exposes the three runtime modes with their wire values', () => {
    expect(RuntimeMode.Server).toBe('revturbine_server');
    expect(RuntimeMode.CustomEndpoints).toBe('custom_endpoints');
    expect(RuntimeMode.LocalOnly).toBe('local_only');
  });

  it('is assignable to RevTurbineRuntimeMode (the derived union)', () => {
    const mode: RevTurbineRuntimeMode = RuntimeMode.LocalOnly;
    expect(mode).toBe('local_only');
    // The union is exactly the set of RuntimeMode values.
    const all: RevTurbineRuntimeMode[] = [RuntimeMode.Server, RuntimeMode.CustomEndpoints, RuntimeMode.LocalOnly];
    expect(new Set(all).size).toBe(3);
  });
});
