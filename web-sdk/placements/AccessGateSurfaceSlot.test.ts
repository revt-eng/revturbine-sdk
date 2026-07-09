import { describe, it, expect } from 'vitest';
import { resolveGateChecks } from './AccessGateSurfaceSlot';

describe('resolveGateChecks — merge of the `can` shorthand and `check` prop', () => {
  it('desugars `can` to an entitlement check', () => {
    expect(resolveGateChecks('brand_kit', undefined)).toEqual([{ entitlement: 'brand_kit' }]);
  });

  it('passes a single `check` through unchanged', () => {
    const check = { usage: 'core_credits', threshold: 80 } as const;
    expect(resolveGateChecks(undefined, check)).toEqual([check]);
  });

  it('passes a `check` array through unchanged', () => {
    const checks = [
      { entitlement: 'core_credits' },
      { usage: 'core_credits', threshold: 100 },
    ] as const;
    expect(resolveGateChecks(undefined, [...checks])).toEqual([...checks]);
  });

  it('merges `can` (first) with `check` when both are supplied', () => {
    expect(
      resolveGateChecks('brand_kit', { usage: 'core_credits', threshold: 90 }),
    ).toEqual([{ entitlement: 'brand_kit' }, { usage: 'core_credits', threshold: 90 }]);
  });

  it('returns an empty list when neither is supplied (degenerate no-op gate)', () => {
    expect(resolveGateChecks(undefined, undefined)).toEqual([]);
  });
});
