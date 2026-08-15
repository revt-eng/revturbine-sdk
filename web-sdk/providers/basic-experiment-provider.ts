/**
 * The one built-in `ExperimentProvider` (plan 183 REQ-3b).
 *
 * Deliberately basic, and deliberately opt-in: nothing registers this for you.
 * A customer with their own experimentation tool registers an adapter that
 * reads *their* assignments instead and loses nothing — the third-party path is
 * first-class, not a fallback. RevTurbine does not own the split.
 *
 * Weights live here, in SDK code, rather than in the Playbook. Assignment is
 * the provider's job, so the config that drives it is client-side
 * configuration, not authored monetization config.
 */
import type { ExperimentProvider, ExperimentProviderState } from '@revt-eng/core';

/** One experiment's arms, and optionally how much of the population sees it. */
export interface BasicBucketerExperiment {
  /**
   * Either an equal split across the listed variant handles, or explicit
   * relative weights. Weights need not sum to anything in particular — they are
   * normalized — so `{ control: 1, variant_b: 3 }` is a 25/75 split.
   *
   * A variant weighted 0 (or negative) is excluded rather than made
   * unreachable-but-present, so removing an arm and zeroing it behave the same.
   */
  variants: readonly string[] | Readonly<Record<string, number>>;
  /**
   * Fraction of subjects enrolled at all, 0..1. Default 1 (everyone).
   *
   * A subject outside it is reported as NOT ENROLLED — the experiment is simply
   * absent from the assignment map, which is distinct from being assigned to a
   * control arm. That distinction is the whole point of a holdout: control is a
   * measured arm, unenrolled is not in the experiment.
   */
  exposure?: number;
}

export interface BasicBucketerOptions {
  /** Keyed by experiment handle — the canonical, version-stable identifier. */
  experiments: Readonly<Record<string, BasicBucketerExperiment>>;
  /**
   * The subject to bucket on. A function is re-read on every resolve, so a
   * later `setUserContext` takes effect; a bare string pins one subject.
   *
   * With no stable subject there is no assignment: bucketing an anonymous or
   * empty id would hand the same person a different arm on the next load and
   * silently poison the results. Absent beats wrong.
   */
  subject: string | (() => string | undefined | null);
}

/**
 * FNV-1a, 32-bit, in explicit integer space.
 *
 * `Math.imul` + `>>> 0` keep every step a defined 32-bit operation. The
 * accumulate-in-a-float variant that appears elsewhere in this codebase drifts
 * once the product exceeds 2^53, which is exactly the kind of thing that makes
 * one runtime bucket a user differently from another.
 *
 * Hashes UTF-16 code units, so the input alphabet is whatever JS strings hold.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Uniform value in [0, 1) derived from `input`. */
function unitInterval(input: string): number {
  return fnv1a32(input) / 0x1_0000_0000;
}

/** Normalize either input form to `[variant, weight]` pairs, dropping non-positive weights. */
function weightedVariants(
  variants: BasicBucketerExperiment['variants'],
): Array<readonly [string, number]> {
  if (Array.isArray(variants)) {
    return (variants as readonly string[]).map((v) => [v, 1] as const);
  }
  return Object.entries(variants as Record<string, number>)
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    .map(([variant, weight]) => [variant, weight] as const);
}

/**
 * Assign one subject to one experiment, or `undefined` for not-enrolled.
 *
 * Exported for testing and for callers who want the decision without the
 * provider wrapper. Pure: same inputs always give the same arm, with no
 * storage, no clock and no randomness involved.
 */
export function bucketSubject(
  subject: string,
  experimentHandle: string,
  experiment: BasicBucketerExperiment,
): string | undefined {
  if (!subject) return undefined;

  const pairs = weightedVariants(experiment.variants);
  if (pairs.length === 0) return undefined;

  const { exposure } = experiment;
  if (exposure !== undefined) {
    if (!(exposure > 0)) return undefined;
    // Salted separately from the variant draw. Sharing one draw would correlate
    // "am I in?" with "which arm?", quietly skewing the split among the
    // enrolled — the classic bucketing bug.
    if (exposure < 1 && unitInterval(`${subject}:${experimentHandle}:exposure`) >= exposure) {
      return undefined;
    }
  }

  const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = unitInterval(`${subject}:${experimentHandle}:variant`) * total;
  for (const [variant, weight] of pairs) {
    cursor -= weight;
    if (cursor < 0) return variant;
  }
  // Only reachable through floating-point slack at the very top of the range.
  return pairs[pairs.length - 1][0];
}

/**
 * Build the built-in bucketer. Register it explicitly to switch it on:
 *
 * ```ts
 * initRevTurbine({
 *   domainProviders: [
 *     createBasicExperimentProvider({
 *       subject: () => currentUserId,
 *       experiments: { pricing_test: { variants: ['control', 'variant_b'] } },
 *     }),
 *   ],
 * });
 * ```
 */
export function createBasicExperimentProvider(
  options: BasicBucketerOptions,
): ExperimentProvider {
  const { experiments, subject } = options;

  return {
    domain: 'experiments',
    resolve(): ExperimentProviderState {
      const resolvedSubject = typeof subject === 'function' ? subject() : subject;
      if (!resolvedSubject) return { assignments: {} };

      const assignments: Record<string, string> = {};
      for (const [handle, experiment] of Object.entries(experiments)) {
        const variant = bucketSubject(resolvedSubject, handle, experiment);
        // Omitted, never nulled: absence is what "not enrolled" looks like
        // everywhere else in this path.
        if (variant !== undefined) assignments[handle] = variant;
      }
      return { assignments };
    },
  };
}
