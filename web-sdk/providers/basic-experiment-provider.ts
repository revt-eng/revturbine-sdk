/**
 * The built-in `ExperimentAssignmentProvider` (plan 183 REQ-3b).
 *
 * Deliberately basic, and deliberately opt-in: nothing registers this for you.
 * A customer with their own experimentation tool registers an adapter that
 * reads *their* assignments instead and loses nothing — the third-party path is
 * first-class, not a fallback. The canonical Experiment owns native desired
 * allocation; external bindings declare whether their allocation is managed
 * or observed.
 */
import type {
  ExperimentAssignmentProvider,
  ExperimentProviderState,
} from '@revt-eng/core';
import type { Experiment } from '@revt-eng/schema';
import type {
  ExperimentAssignmentFactDeclaration,
  ExperimentAssignmentFactMetadataCarrier,
} from './assignment-facts';

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
 * The allocation fields owned by one canonical Experiment version.
 *
 * Derived from the schema type rather than redeclared, so schema evolution is
 * visible here at compile time without making the adapter require unrelated
 * persistence fields.
 */
export interface CanonicalExperimentAllocation {
  handle: Experiment['handle'];
  traffic_allocation: Experiment['traffic_allocation'];
  /** Unit represented by the stable subject identifier; defaults to `user`. */
  assignment_unit?: Experiment['assignment_unit'];
  variants: ReadonlyArray<Pick<Experiment['variants'][number], 'variant_id' | 'weight'>>;
  /**
   * Canonical experiment version — the `Experiment.sequence` this allocation
   * was taken from (plan 224, war-games spec §9.1). When present, the native
   * provider derives an {@link ExperimentAssignmentFactDeclaration} so
   * assignments emit the `experiment_assigned` assignment fact with the real
   * (handle, version) SRM join key. When absent, assignment still works but
   * no fact is emitted for this experiment — a fact with a fabricated
   * version is worse than a missing one.
   */
  sequence?: Experiment['sequence'];
}

/** One supported canonical experiment assignment unit. */
export type NativeExperimentAssignmentUnit = NonNullable<Experiment['assignment_unit']>;

/** Raised before provider registration when its subject cannot serve an experiment's unit. */
export class UnsupportedExperimentAssignmentUnitError extends Error {
  /** Experiment whose requested assignment unit cannot be served. */
  readonly experimentHandle: string;
  /** Assignment unit requested by the canonical Experiment version. */
  readonly requestedUnit: NativeExperimentAssignmentUnit;
  /** Unit represented by the provider's configured subject. */
  readonly subjectUnit: NativeExperimentAssignmentUnit;

  /** Construct an unsupported-unit launch error. */
  constructor(
    experimentHandle: string,
    requestedUnit: NativeExperimentAssignmentUnit,
    subjectUnit: NativeExperimentAssignmentUnit,
  ) {
    super(
      `Experiment "${experimentHandle}" requests assignment unit "${requestedUnit}", `
      + `but this native provider is configured for "${subjectUnit}"; refuse launch `
      + 'instead of substituting an assignment unit.',
    );
    this.name = 'UnsupportedExperimentAssignmentUnitError';
    this.experimentHandle = experimentHandle;
    this.requestedUnit = requestedUnit;
    this.subjectUnit = subjectUnit;
  }
}

/** Options for the native assignment provider backed by Experiment versions. */
export interface NativeExperimentAssignmentOptions {
  /** Canonical, versioned Experiment allocations to execute. */
  experiments: readonly CanonicalExperimentAllocation[];
  /** Stable assignment subject, re-read per resolution when supplied as a function. */
  subject: BasicBucketerOptions['subject'];
  /** Unit represented by `subject`; defaults to `user` for backward compatibility. */
  subjectUnit?: NativeExperimentAssignmentUnit;
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
 * Translate canonical fraction weights into the bucketer's ratio + exposure
 * representation.
 *
 * For weights whose positive sum is below one, the missing fraction remains
 * unenrolled: `[0.3, 0.3]` becomes ratio `0.3:0.3` at exposure `0.6`, realizing
 * 30% / 30% / 40% unassigned. If fractions are oversubscribed (sum above one),
 * they are normalized proportionally within `traffic_allocation`; this keeps
 * the conversion total for every schema-valid vector. Zero weights are
 * omitted, matching `bucketSubject()`'s established exclusion semantics.
 */
export function adaptExperimentVersionToBucketer(
  experiment: CanonicalExperimentAllocation,
): BasicBucketerExperiment {
  const variants: Record<string, number> = {};
  for (const variant of experiment.variants) {
    if (!Number.isFinite(variant.weight) || variant.weight <= 0) continue;
    variants[variant.variant_id] = (variants[variant.variant_id] ?? 0) + variant.weight;
  }

  const weightSum = Object.values(variants).reduce((sum, weight) => sum + weight, 0);
  const trafficAllocation = Number.isFinite(experiment.traffic_allocation)
    ? Math.min(1, Math.max(0, experiment.traffic_allocation))
    : 0;

  return {
    variants,
    exposure: trafficAllocation * Math.min(1, weightSum),
  };
}

/**
 * Build the native assignment provider whose allocation authority is the
 * canonical Experiment version rather than duplicated SDK configuration.
 */
export function createNativeExperimentAssignmentProvider(
  options: NativeExperimentAssignmentOptions,
): ExperimentAssignmentProvider & ExperimentAssignmentFactMetadataCarrier {
  const subjectUnit = options.subjectUnit ?? 'user';
  const experiments: Record<string, BasicBucketerExperiment> = {};
  const assignmentFactDeclarations: ExperimentAssignmentFactDeclaration[] = [];
  for (const experiment of options.experiments) {
    const requestedUnit = experiment.assignment_unit ?? 'user';
    if (requestedUnit !== subjectUnit) {
      throw new UnsupportedExperimentAssignmentUnitError(
        experiment.handle,
        requestedUnit,
        subjectUnit,
      );
    }
    experiments[experiment.handle] = adaptExperimentVersionToBucketer(experiment);
    // Version carriage for the assignment plane (plan 224, spec §9.1): only an
    // allocation that states its canonical version can produce a truthful
    // (handle, version) fact — the others assign but emit nothing.
    const sequence = experiment.sequence;
    if (typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 1) {
      assignmentFactDeclarations.push({
        experimentHandle: experiment.handle,
        experimentVersion: sequence,
        assignmentUnit: requestedUnit,
        subject: options.subject,
      });
    }
  }
  return {
    ...createBasicExperimentProvider({ experiments, subject: options.subject }),
    ...(assignmentFactDeclarations.length > 0 ? { assignmentFactDeclarations } : {}),
  };
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
): ExperimentAssignmentProvider {
  const { experiments, subject } = options;

  return {
    domain: 'experiments',
    providerHandle: 'revturbine:native',
    ownedExperimentHandles: Object.keys(experiments),
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
