/**
 * Type-level exhaustiveness of the runtime recognized-key lists (BL-0352).
 *
 * Checked by `tsc` (`pnpm check:types:exact`), not by vitest — there is
 * nothing to run. The same assertion used to live in
 * `customer-side-aliases.test.ts` as an `expectTypeOf(...)` call, which never
 * type-checked: vitest does not typecheck `*.test.ts`, and every tsconfig
 * excludes them. Under `tsc` it was already failing on `main` — four
 * `UserContextInput` fields (`experiments`, `builtin_dimensions`,
 * `activity_score`, `activity_score_computed_at`) had reached
 * `RevTurbineUpdateInput` without reaching `RECOGNIZED_UPDATE_KEYS`, so
 * `update()` accepted them at compile time and silently dropped them at run
 * time.
 *
 * Each assertion is a real derivation from the types. A field added to the
 * schema's `UserContext` now fails this file until someone decides, in one
 * place, whether the browser may write it: add it to the runtime list, or
 * omit it from the browser input types (server-assigned — see
 * `ServerAssignedUserContextKey` in `customer-side.ts`).
 *
 * BL-0381 (D-46): `builtin_dimensions` is server-assigned. The browser never
 * asserts a built-in dimension value, so it is omitted from every browser
 * input type and runtime list; re-adding it to any of them fails the
 * server-assigned assertions below.
 */
import type {
  IdentifyContextInput,
  RecognizedIdentifyKey,
  RecognizedUpdateKey,
  RevTurbineUpdateInput,
  RevTurbineUserContext,
} from './customer-side';

/** `true` iff `A` and `B` are the identical type (not merely mutually assignable). */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Compiles only when its argument is `true`. */
type Assert<T extends true> = T;

// ── update() ────────────────────────────────────────────────────────────────

/** Fields `RevTurbineUpdateInput` declares that `update()` would drop. Must be empty. */
type UpdateKeysMissingAtRuntime = Exclude<keyof RevTurbineUpdateInput, RecognizedUpdateKey>;
/** Runtime entries the type does not declare. Must be empty (`satisfies` also guards this). */
type UpdateKeysMissingFromType = Exclude<RecognizedUpdateKey, keyof RevTurbineUpdateInput>;

export type UpdateListCoversType = Assert<Equals<UpdateKeysMissingAtRuntime, never>>;
export type UpdateListWithinType = Assert<Equals<UpdateKeysMissingFromType, never>>;

// ── identify() ──────────────────────────────────────────────────────────────
// identify() is the identity verb: it merges a deliberately narrow set of
// keys (plan 168 REQ-3, plan 191) and drops-and-reports the rest. Its input
// type is wider than that set today, so the gap is not `never` — it is pinned
// to an explicit, reviewed list. A new `UserContextInput` field lands in this
// Exclude and fails the equality until it is added to one side or the other.
// Narrowing `IdentifyContextInput` to the merged keys is a breaking type
// change for callers that pass these today (they are dropped at runtime
// either way), so it waits for 0.12.0.

/** IdentifyContextInput keys identify() accepts at compile time but does not merge (dropped with a warning). */
type IdentifyAcknowledgedUnmergedKey =
  | 'email_type'
  | 'trial'
  | 'payment_failed'
  | 'payment_at_risk'
  | 'tiers'
  | 'instances'
  | 'experiments'
  | 'derived_config_version'
  | 'context_hash'
  | 'derived_computed_at';

export type IdentifyGapIsAcknowledged = Assert<
  Equals<Exclude<keyof IdentifyContextInput, RecognizedIdentifyKey>, IdentifyAcknowledgedUnmergedKey>
>;
export type IdentifyListWithinType = Assert<
  Equals<Exclude<RecognizedIdentifyKey, keyof IdentifyContextInput>, never>
>;

// ── Server-assigned keys stay out of every browser input (D-36, D-46) ──────
// BL-0352 added the seat/activity keys; BL-0381 added `builtin_dimensions`;
// BL-0382 added `customer_builtin_dimensions` (server-key writes only, D-47).

type ServerAssigned =
  | 'seat_type_handle'
  | 'activity_score'
  | 'activity_score_computed_at'
  | 'builtin_dimensions'
  | 'customer_builtin_dimensions';

export type NoServerKeysOnUserContext = Assert<Equals<Extract<keyof RevTurbineUserContext, ServerAssigned>, never>>;
export type NoServerKeysOnUpdateInput = Assert<Equals<Extract<keyof RevTurbineUpdateInput, ServerAssigned>, never>>;
export type NoServerKeysOnIdentifyInput = Assert<Equals<Extract<keyof IdentifyContextInput, ServerAssigned>, never>>;
export type NoServerKeysInUpdateList = Assert<Equals<Extract<RecognizedUpdateKey, ServerAssigned>, never>>;
export type NoServerKeysInIdentifyList = Assert<Equals<Extract<RecognizedIdentifyKey, ServerAssigned>, never>>;

// ── Negative controls: the helpers really do fail ──────────────────────────
// Without these, an `Equals` that always returned `true` would pass every
// assertion above. Each `@ts-expect-error` is itself an assertion: if the
// line stops erroring, tsc fails with "Unused '@ts-expect-error' directive".

// @ts-expect-error — a list missing a declared field is not exhaustive
export type NegativeMissingKey = Assert<Equals<Exclude<keyof RevTurbineUpdateInput, Exclude<RecognizedUpdateKey, 'experiments'>>, never>>;

// @ts-expect-error — an acknowledged-gap list missing an entry fails the identify equality
export type NegativeIdentifyGap = Assert<Equals<Exclude<keyof IdentifyContextInput, RecognizedIdentifyKey>, Exclude<IdentifyAcknowledgedUnmergedKey, 'trial'>>>;

// @ts-expect-error — the server-assigned check detects a key that IS present
export type NegativeServerKey = Assert<Equals<Extract<keyof RevTurbineUpdateInput, 'plan_handle'>, never>>;

// @ts-expect-error — `builtin_dimensions` re-added to a browser input is caught (BL-0381)
export type NegativeBuiltinDimensionsReadded = Assert<Equals<Extract<keyof (RevTurbineUpdateInput & { builtin_dimensions?: Record<string, string> }), ServerAssigned>, never>>;
