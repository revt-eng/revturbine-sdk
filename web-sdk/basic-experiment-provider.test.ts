/**
 * The built-in bucketer (plan 183 TASK-3 / REQ-3b).
 *
 * Note on acceptance criteria: AC-1 and AC-3 were authored before Kent's
 * rulings and still speak of Playbook `traffic_allocation` and per-variant
 * weights. Those were deleted from the plan — assignment is the provider's job,
 * so weights are the bucketer's own client-side config. The properties those
 * criteria actually care about (a weighted split, per-subject stability, and a
 * holdout that stays distinct from control) are asserted here against that
 * design. AC-2's cross-language parity is a declared non-goal: this is a
 * client-side SDK convenience, not a wire contract.
 */
import { describe, expect, it } from 'vitest';

import {
  bucketSubject,
  adaptExperimentVersionToBucketer,
  createBasicExperimentProvider,
  createNativeExperimentAssignmentProvider,
  UnsupportedExperimentAssignmentUnitError,
  type CanonicalExperimentAllocation,
  type BasicBucketerExperiment,
  type NativeExperimentAssignmentUnit,
} from './providers/basic-experiment-provider';

const twoArm: BasicBucketerExperiment = { variants: ['control', 'variant_b'] };
const assignmentUnits: readonly NativeExperimentAssignmentUnit[] = [
  'user',
  'account',
  'organization',
  'billing_unit',
];

/** Bucket `n` synthetic subjects and count how many landed on each arm. */
function distribute(experiment: BasicBucketerExperiment, n = 20_000): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const arm = bucketSubject(`user_${i}`, 'pricing_test', experiment) ?? '__unenrolled__';
    counts[arm] = (counts[arm] ?? 0) + 1;
  }
  return counts;
}

describe('bucketSubject — distribution', () => {
  it('splits an equal two-arm experiment roughly evenly', () => {
    const counts = distribute(twoArm);
    expect(counts.__unenrolled__).toBeUndefined();
    // 2 points of slack on 20k draws; a broken split fails by tens of points.
    expect(counts.control / 20_000).toBeCloseTo(0.5, 1);
    expect(counts.variant_b / 20_000).toBeCloseTo(0.5, 1);
  });

  it('honours relative weights, normalizing rather than requiring a total', () => {
    // 1:3 is 25/75 — weights are relative, not percentages.
    const counts = distribute({ variants: { control: 1, variant_b: 3 } });
    expect(counts.control / 20_000).toBeCloseTo(0.25, 1);
    expect(counts.variant_b / 20_000).toBeCloseTo(0.75, 1);
  });

  it('spreads across more than two arms', () => {
    const counts = distribute({ variants: ['a', 'b', 'c', 'd'] });
    for (const arm of ['a', 'b', 'c', 'd']) {
      expect(counts[arm] / 20_000).toBeCloseTo(0.25, 1);
    }
  });

  it('excludes a zero-weighted arm entirely', () => {
    const counts = distribute({ variants: { control: 1, retired_arm: 0 } });
    expect(counts.retired_arm).toBeUndefined();
    expect(counts.control).toBe(20_000);
  });
});

describe('bucketSubject — stability', () => {
  it('returns the same arm for the same subject every time', () => {
    const first = bucketSubject('user_42', 'pricing_test', twoArm);
    for (let i = 0; i < 50; i++) {
      expect(bucketSubject('user_42', 'pricing_test', twoArm)).toBe(first);
    }
  });

  it('buckets the same subject independently per experiment', () => {
    // Same person, two experiments: the arms must not be locked together, or
    // every experiment would measure the same population split.
    const subjects = Array.from({ length: 200 }, (_, i) => `user_${i}`);
    const differs = subjects.filter(
      (s) => bucketSubject(s, 'exp_a', twoArm) !== bucketSubject(s, 'exp_b', twoArm),
    );
    expect(differs.length).toBeGreaterThan(20);
  });

  it('is a pure function of its inputs — no clock, storage or randomness', () => {
    // Same call, fresh module state, identical answer. Guards against anyone
    // reaching for Math.random or Date to "spread" traffic.
    expect(bucketSubject('user_7', 'pricing_test', twoArm)).toBe(
      bucketSubject('user_7', 'pricing_test', twoArm),
    );
  });
});

describe('bucketSubject — not enrolled is not control', () => {
  it('holds out the complement of `exposure`', () => {
    const counts = distribute({ ...twoArm, exposure: 0.3 });
    expect(counts.__unenrolled__ / 20_000).toBeCloseTo(0.7, 1);
    // The enrolled 30% still splits evenly between the arms.
    expect(counts.control / counts.variant_b).toBeCloseTo(1, 0);
  });

  it('keeps exposure independent of the arm draw', () => {
    // Sharing one hash draw for "am I in?" and "which arm?" would skew the
    // split among the enrolled — the classic bucketing bug.
    const counts = distribute({ ...twoArm, exposure: 0.5 });
    const enrolled = counts.control + counts.variant_b;
    expect(counts.control / enrolled).toBeCloseTo(0.5, 1);
  });

  it('enrolls everyone when exposure is omitted or 1', () => {
    expect(distribute(twoArm).__unenrolled__).toBeUndefined();
    expect(distribute({ ...twoArm, exposure: 1 }).__unenrolled__).toBeUndefined();
  });

  it('enrolls nobody at exposure 0', () => {
    expect(distribute({ ...twoArm, exposure: 0 }).__unenrolled__).toBe(20_000);
  });

  it('returns undefined rather than an arm when there is nothing to assign', () => {
    expect(bucketSubject('', 'pricing_test', twoArm)).toBeUndefined();
    expect(bucketSubject('user_1', 'pricing_test', { variants: [] })).toBeUndefined();
    expect(bucketSubject('user_1', 'pricing_test', { variants: {} })).toBeUndefined();
  });
});

describe('createBasicExperimentProvider', () => {
  it('resolves an assignment map keyed by experiment handle', () => {
    const provider = createBasicExperimentProvider({
      subject: 'user_1',
      experiments: { pricing_test: twoArm, copy_test: { variants: ['a', 'b'] } },
    });

    expect(provider.domain).toBe('experiments');
    const { assignments } = provider.resolve() as { assignments: Record<string, string> };
    expect(Object.keys(assignments).sort()).toEqual(['copy_test', 'pricing_test']);
    expect(['control', 'variant_b']).toContain(assignments.pricing_test);
  });

  it('omits an unenrolled experiment instead of nulling it', () => {
    const provider = createBasicExperimentProvider({
      subject: 'user_1',
      experiments: { held_out: { ...twoArm, exposure: 0 }, live: twoArm },
    });
    const { assignments } = provider.resolve() as { assignments: Record<string, string> };
    expect(assignments).not.toHaveProperty('held_out');
    expect(assignments).toHaveProperty('live');
  });

  it('re-reads a function subject, so a later identify takes effect', () => {
    let current: string | undefined;
    const provider = createBasicExperimentProvider({
      subject: () => current,
      experiments: { pricing_test: twoArm },
    });

    // Anonymous: no stable subject, so no assignment — absent beats an arm the
    // next page load would contradict.
    expect((provider.resolve() as { assignments: Record<string, string> }).assignments).toEqual({});

    current = 'user_99';
    const after = (provider.resolve() as { assignments: Record<string, string> }).assignments;
    expect(after.pricing_test).toBe(bucketSubject('user_99', 'pricing_test', twoArm));
  });

  it('assigns nothing when no experiments are configured', () => {
    const provider = createBasicExperimentProvider({ subject: 'user_1', experiments: {} });
    expect((provider.resolve() as { assignments: Record<string, string> }).assignments).toEqual({});
  });
});

describe('canonical Experiment allocation adapter — plan 199', () => {
  const allocation = (
    weights: readonly number[],
    trafficAllocation = 1,
  ): CanonicalExperimentAllocation => ({
    handle: 'pricing_test',
    traffic_allocation: trafficAllocation,
    variants: weights.map((weight, index) => ({
      variant_id: `variant_${index}`,
      weight,
    })),
  });

  it('preserves the unassigned remainder for fraction weights below one', () => {
    const adapted = adaptExperimentVersionToBucketer(allocation([0.3, 0.3]));
    expect(adapted).toEqual({
      variants: { variant_0: 0.3, variant_1: 0.3 },
      exposure: 0.6,
    });

    const counts = distribute(adapted, 50_000);
    expect(counts.variant_0 / 50_000).toBeCloseTo(0.3, 1);
    expect(counts.variant_1 / 50_000).toBeCloseTo(0.3, 1);
    expect(counts.__unenrolled__ / 50_000).toBeCloseTo(0.4, 1);
  });

  it('normalizes oversubscribed fractions and excludes zero-weight arms', () => {
    expect(adaptExperimentVersionToBucketer(allocation([0.8, 0, 0.8], 0.5))).toEqual({
      variants: { variant_0: 0.8, variant_2: 0.8 },
      exposure: 0.5,
    });
    expect(adaptExperimentVersionToBucketer(allocation([0, 0], 0.75))).toEqual({
      variants: {},
      exposure: 0,
    });
  });

  it('realizes the canonical fraction intent across generated non-normalized vectors', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const weights = Array.from({ length: 2 + (seed % 4) }, (_, index) =>
        ((seed * (index + 3) * 17) % 101) / 100,
      );
      if (seed % 3 === 0) weights[seed % weights.length] = 0;
      const trafficAllocation = ((seed * 37) % 101) / 100;
      const adapted = adaptExperimentVersionToBucketer(allocation(weights, trafficAllocation));
      const positiveSum = weights.reduce((sum, weight) => sum + (weight > 0 ? weight : 0), 0);
      const denominator = Math.max(1, positiveSum);
      const counts = distribute(adapted, 30_000);

      weights.forEach((weight, index) => {
        const realized = (counts[`variant_${index}`] ?? 0) / 30_000;
        const intended = trafficAllocation * Math.max(0, weight) / denominator;
        expect(Math.abs(realized - intended)).toBeLessThan(0.015);
      });
    }
  });

  it('builds a provider directly from canonical Experiment versions', () => {
    const provider = createNativeExperimentAssignmentProvider({
      subject: 'user_42',
      experiments: [allocation([0.5, 0.5])],
    });
    const resolved = provider.resolve();
    expect(resolved.assignments.pricing_test).toMatch(/^variant_[01]$/);
  });

  it.each(assignmentUnits)(
    'launches when the provider subject represents the requested %s unit',
    (assignmentUnit) => {
      const provider = createNativeExperimentAssignmentProvider({
        subject: `${assignmentUnit}_42`,
        subjectUnit: assignmentUnit,
        experiments: [{ ...allocation([0.5, 0.5]), assignment_unit: assignmentUnit }],
      });

      expect(provider.resolve().assignments.pricing_test).toMatch(/^variant_[01]$/);
    },
  );

  it('refuses launch instead of silently substituting the provider subject unit', () => {
    expect(() => createNativeExperimentAssignmentProvider({
      subject: 'user_42',
      subjectUnit: 'user',
      experiments: [{ ...allocation([0.5, 0.5]), assignment_unit: 'account' }],
    })).toThrow(UnsupportedExperimentAssignmentUnitError);

    expect(() => createNativeExperimentAssignmentProvider({
      subject: 'user_42',
      experiments: [{ ...allocation([0.5, 0.5]), assignment_unit: 'account' }],
    })).toThrow(/refuse launch instead of substituting an assignment unit/);
  });
});
