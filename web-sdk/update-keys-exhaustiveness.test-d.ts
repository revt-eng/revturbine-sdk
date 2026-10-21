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
// keys (plan 168 REQ-3, plan 191) and drops-and-reports the rest at runtime
// for plain-JS callers. Since 0.12.0 its input type declares exactly that set:
// the gap is `never`, so a key identify() would drop is a compile error, and
// a new `UserContextInput` field lands in this Exclude and fails the equality
// until it is merged or omitted from `IdentifyContextInput`.

export type IdentifyTypeIsExactlyMerged = Assert<
  Equals<Exclude<keyof IdentifyContextInput, RecognizedIdentifyKey>, never>
>;

// The former acknowledged-unmerged keys now fail at compile time, including
// through a variable (Exact<>).
declare const sdk: import('./customer-side').RevTurbineCustomerSdk;
const trialViaVariable = { plan_handle: 'pro', trial: { in_trial: true } };
// @ts-expect-error — `trial` is not an identify() field since 0.12.0
sdk.identify('u_1', trialViaVariable);

// ── setUserContext() is Exact<> since 0.12.0 ───────────────────────────────
const junkViaVariable = { id: 'u_1', plan_handle: 'pro', not_a_field: 1 };
// @ts-expect-error — an undeclared key is a compile error even through a variable
sdk.setUserContext(junkViaVariable);
sdk.setUserContext({ id: 'u_1', plan_handle: 'pro', custom: { anything: 1 } });

// ── initialData.placementsByLookupKey was removed in 0.12.0 (BL-0537) ──────
const seededData: import('./customer-side').RevTurbineLocalRuntimeData = {
  // @ts-expect-error — the seeded placement lane is gone
  placementsByLookupKey: {},
};
void seededData;
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
