/**
 * Type-level fixtures for user-context exactness (plan 191 REQ-3 / AC-3).
 *
 * These assert COMPILE-TIME behavior, so they are checked by `tsc`
 * (`pnpm check:types:exact`), not by vitest — there is nothing to run. Every
 * `@ts-expect-error` below is an assertion in the strict sense: if the line
 * ever stops erroring, `tsc` fails with "Unused '@ts-expect-error'
 * directive", and the guarantee is gone.
 *
 * What is being guarded: the shape the docs used to teach —
 * `user: { id, context: { plan_handle } }` — type-checked cleanly whenever
 * the object was built anywhere other than directly at the call site,
 * because TypeScript's excess-property check applies only to fresh object
 * literals. The user then silently had no plan, in production, with the
 * runtime warning compiled out. `Exact<Shape, T>` closes that hole.
 */
import type { Exact, IdentifyContextInput, RevTurbineUpdateInput, RevTurbineUserContext } from './customer-side';

declare function identify<T extends IdentifyContextInput>(
  userId: string,
  context?: Exact<IdentifyContextInput, T>,
): void;

declare function update<T extends RevTurbineUpdateInput>(patch: Exact<RevTurbineUpdateInput, T>): void;

declare function init<TUser extends RevTurbineUserContext = RevTurbineUserContext>(
  options: { user?: Exact<RevTurbineUserContext, TUser> },
): void;

// ── identify() ──────────────────────────────────────────────────────────────

// The canonical shape compiles.
identify('u_1', { plan_handle: 'pro' });
identify('u_1', { plan_handle: 'pro', plan: { handle: 'pro', name: 'Professional' } });
// Free-form values are welcome — under `custom`, which stays open.
identify('u_1', { plan_handle: 'pro', custom: { role: 'editor', seats: 4 } });
// No context at all is fine (identity only).
identify('u_1');

// @ts-expect-error — `context` is not a user-context field (THE documented trap)
identify('u_1', { context: { plan_handle: 'pro' } });

// @ts-expect-error — a bare trait must go under `custom`, not the top level
identify('u_1', { role: 'editor' });

// @ts-expect-error — the legacy plain-traits overload is gone (plan 191 Q-2)
identify('u_1', { anything: 'goes' });

// ── The intermediate case: why `Exact` exists ───────────────────────────────
// TypeScript's excess-property check would have passed all three of these,
// because the value is no longer a fresh literal at the call site. This is
// the exact path the flagship docs pages took (an un-annotated `useMemo`).

const viaVariable = { context: { plan_handle: 'pro' } };
// @ts-expect-error — still rejected through a variable
identify('u_1', viaVariable);

function buildContext() {
  // Deliberately un-annotated: the inferred type carries the excess key.
  return { id: 'u_1', context: { plan_handle: 'pro' } };
}
// @ts-expect-error — still rejected through a helper's inferred return type
init({ user: buildContext() });

const memoized = (() => ({ user: { id: 'u_1', context: { plan_handle: 'pro' } } }))();
// @ts-expect-error — still rejected through the useMemo-shaped intermediate
init(memoized);

// The corrected shape passes through the same intermediates.
const correctViaVariable = { id: 'u_1', plan_handle: 'pro' };
init({ user: correctViaVariable });

// ── update() (Q-2: setTraits IS update) ─────────────────────────────────────

update({ plan_handle: 'pro' });
update({ custom: { role: 'admin' } });
update({ usage: { generations: 25 } });

// @ts-expect-error — a bare entitlement handle is not a usage report
update({ batch_export: 5 });

// @ts-expect-error — the identity handle is not patchable; use identify()
update({ id: 'u_2' });

// @ts-expect-error — same wrapper trap, on the patch verb
update({ context: { plan_handle: 'pro' } });
