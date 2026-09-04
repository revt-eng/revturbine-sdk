/**
 * Assignment-fact carriage (plan 224 TASK-8, war-games spec §9.1).
 *
 * The `experiment_assigned` clickstream event is the assignment plane's source
 * of truth: one fact per (experiment_handle, experiment_version, subject) when
 * the resolved assignment snapshot enrolls a subject. The snapshot itself
 * (`ExperimentVariantSelection`) deliberately carries handles only — the
 * canonical experiment VERSION is not part of the runtime assignment contract
 * (assignment spec §8: the version travels separately in telemetry). This
 * module is that separate channel: a declaration that binds an experiment
 * handle to the canonical version (`Experiment.sequence`) and assignment unit
 * the fact must carry.
 *
 * Declaration-gated by design, mirroring the taxonomy's own discipline: an
 * assignment with no declaration emits NO fact rather than a fact with a
 * fabricated version — a wrong (handle, version) join key poisons SRM, which
 * is worse than a missing row. Unenrolled subjects also emit nothing:
 * not-enrolled is absence (assignment spec §4), never an `enrolled: false`
 * fact.
 */
import type { Experiment } from '@revt-eng/schema';

/** One supported canonical experiment assignment unit (war-games spec §9.1). */
export type AssignmentFactUnit = NonNullable<Experiment['assignment_unit']>;

/**
 * Binds one experiment handle to the canonical-version metadata its
 * `experiment_assigned` assignment facts must carry (plan 224, spec §9.1).
 *
 * Supply these either through
 * `RevTurbineInitOptions.experimentAssignmentFacts` (works for ANY assignment
 * source, external adapters included) or — for the native provider — via
 * `CanonicalExperimentAllocation.sequence`, which derives a declaration
 * automatically. An assigned experiment with no declaration emits no fact.
 */
export interface ExperimentAssignmentFactDeclaration {
  /** Canonical experiment handle the declaration applies to. */
  experimentHandle: string;
  /**
   * Canonical experiment version — the `Experiment.sequence` of the version
   * whose allocation is live. Integer ≥ 1; the fact's (handle, version) pair
   * is the SRM join key, so this must be the real canonical version, never a
   * guess.
   */
  experimentVersion: number;
  /**
   * Unit the subject identifier represents. Defaults to `'user'`, matching
   * the native provider's default.
   */
  assignmentUnit?: AssignmentFactUnit;
  /**
   * Stable subject identifier for the declared unit. A function is re-read on
   * every emission so a later identity change takes effect; a bare string
   * pins one subject. When omitted, the SDK's user-context `id` is used.
   * With no resolvable subject there is no fact — absent beats wrong.
   */
  subject?: string | (() => string | undefined | null);
}

/**
 * Optional carrier surface for assignment-fact metadata on an experiment
 * provider. The native provider implements it when its allocations carry
 * `sequence`; the SDK harvests declarations from every registered experiment
 * provider that exposes it.
 */
export interface ExperimentAssignmentFactMetadataCarrier {
  /** Declarations describing the canonical versions this provider allocates. */
  readonly assignmentFactDeclarations?: readonly ExperimentAssignmentFactDeclaration[];
}

/** Defensive membership check for the closed assignment-unit vocabulary. */
function isAssignmentFactUnit(value: unknown): value is AssignmentFactUnit { // sdk-ok: boundary-parse
  return value === 'user' || value === 'account' || value === 'organization' || value === 'billing_unit';
}

/**
 * Defensively validate one declaration from a plain-JS caller. The SDK is
 * exposed as `window.RevTurbine`, so shapes are checked, never assumed.
 */
export function isExperimentAssignmentFactDeclaration(
  value: unknown, // sdk-ok: boundary-parse
): value is ExperimentAssignmentFactDeclaration {
  if (typeof value !== 'object' || value === null) return false;
  const candidate: Partial<Record<keyof ExperimentAssignmentFactDeclaration, unknown>> = value;
  if (typeof candidate.experimentHandle !== 'string' || candidate.experimentHandle.trim() === '') {
    return false;
  }
  if (
    typeof candidate.experimentVersion !== 'number'
    || !Number.isInteger(candidate.experimentVersion)
    || candidate.experimentVersion < 1
  ) {
    return false;
  }
  if (candidate.assignmentUnit !== undefined && !isAssignmentFactUnit(candidate.assignmentUnit)) {
    return false;
  }
  if (
    candidate.subject !== undefined
    && typeof candidate.subject !== 'string'
    && typeof candidate.subject !== 'function'
  ) {
    return false;
  }
  return true;
}

/**
 * Harvest valid assignment-fact declarations from providers exposing the
 * {@link ExperimentAssignmentFactMetadataCarrier} surface. Later sources win
 * on a duplicate handle, so pass the most authoritative source last.
 */
export function collectAssignmentFactDeclarations(
  sources: ReadonlyArray<object | undefined>,
  explicit?: readonly ExperimentAssignmentFactDeclaration[],
): ReadonlyMap<string, ExperimentAssignmentFactDeclaration> {
  const byHandle = new Map<string, ExperimentAssignmentFactDeclaration>();
  const absorb = (declarations: unknown): void => { // sdk-ok: boundary-parse
    if (!Array.isArray(declarations)) return;
    for (const declaration of declarations) {
      if (!isExperimentAssignmentFactDeclaration(declaration)) continue;
      byHandle.set(declaration.experimentHandle.trim(), declaration);
    }
  };
  for (const source of sources) {
    if (source === undefined || !('assignmentFactDeclarations' in source)) continue;
    absorb(Reflect.get(source, 'assignmentFactDeclarations'));
  }
  absorb(explicit);
  return byHandle;
}
