/**
 * Type-level fixtures for init-options exactness (plan 233 REQ-2b / AC-2b).
 *
 * These assert COMPILE-TIME behaviour, so they are checked by `tsc`
 * (`pnpm check:types:exact`), not by vitest — there is nothing to run. Every
 * `@ts-expect-error` below is an assertion in the strict sense: if a line ever
 * stops erroring, `tsc` fails with "Unused '@ts-expect-error' directive", and
 * the guarantee is gone.
 *
 * What is being guarded: TypeScript's excess-property check applies only to
 * fresh object literals. Options assembled in a variable — or in an
 * un-annotated `useMemo`, which is exactly how React integrations build them —
 * carried unknown keys with no diagnostic at all. A typo'd or stale option was
 * simply ignored at runtime.
 *
 * SCOPE LIMIT, stated because it is easy to over-read this file: exactness
 * cannot catch a wrong VALUE. The escalated `tenant_id` defect was never
 * reachable from here; that one is caught by init-time validation and the
 * reachable init status (plan 233 REQ-1/2/3). This closes an adjacent hole,
 * not that one.
 *
 * A CORRECTION to what this file said when it shipped: it claimed exactness
 * “cannot see inside a Playbook fetched at runtime — a served artifact is
 * `Record<string, unknown>` by necessity.” That was wrong on both counts.
 * `UnvalidatedConfigArtifact` was a bare record because TypeScript widens JSON
 * *module imports*, which is a build-time ergonomics problem and says nothing
 * about served artifacts; and widening only affects *literal* types, so the
 * body arrays were checkable all along. They are now structurally required —
 * see `playbook-structural.test-d.ts`.
 */
import { initRevTurbine } from './customer-side';
import type { ExactInitOptions, RevTurbineInitInputOptions } from './customer-side';
import type { ConfigArtifact } from './config-artifact';

const playbook = {} as ConfigArtifact;

/* ── Accepted shapes ──────────────────────────────────────────────────── */

// Local-only minimal: `localRuntime.playbook` present, transport omitted.
initRevTurbine({ localRuntime: { playbook } });

// The same options built in a VARIABLE rather than inline. This is the shape
// excess-property checking never saw, and the reason `ExactInitOptions` exists.
const localOptions = { tenantId: 't_1', localRuntime: { playbook } };
initRevTurbine(localOptions);

// Full transport options.
initRevTurbine({
  tenantId: 't_1',
  apiKey: 'sk_test',
  endpoint: 'https://edge.example.com',
  mode: 'react',
});

// Keys that live on only ONE union branch must still be accepted — `keyof` over
// a union yields the INTERSECTION of its members' keys, so a naive
// `Exact<RevTurbineInitInputOptions, T>` would have rejected both of these.
initRevTurbine({ localRuntime: { playbook } });
initRevTurbine({ tenantId: 't_1', localRuntime: { playbook }, provider: undefined });

/* ── Rejected: an unrecognized key ────────────────────────────────────── */

initRevTurbine({
  tenantId: 't_1',
  localRuntime: { playbook },
  // @ts-expect-error - `tenant_id` is the Playbook's field name, not an init
  // option. NOTE: this one was already caught before `ExactInitOptions` — it is
  // a fresh object literal, so excess-property checking fires. Kept as
  // documentation of the confusion the escalated integration hit, not as
  // evidence for this guard. The load-bearing cases are the three below, which
  // build their options in a VARIABLE.
  tenant_id: 't_1',
});

const withTypo = { tenantId: 't_1', localRuntime: { playbook }, apikey: 'sk_test' };
// @ts-expect-error - `apikey` is a casing typo for `apiKey`. Built in a
// variable, so excess-property checking never fired on it.
initRevTurbine(withTypo);

const withStaleOption = { tenantId: 't_1', localRuntime: { playbook }, exportedConfig: playbook };
// @ts-expect-error - `exportedConfig` belongs inside `localRuntime`, not at the
// top level. A plausible mistake, and previously a silent one.
initRevTurbine(withStaleOption);

/* ── Rejected: a missing required key ─────────────────────────────────── */

// @ts-expect-error - neither branch is satisfiable: no `localRuntime`, so the
// local-only branch does not apply, and the transport branch needs `tenantId`.
initRevTurbine({});

// @ts-expect-error - `localRuntime` without a playbook (or the deprecated
// `exportedConfig` alias) satisfies neither arm of its inner union.
initRevTurbine({ localRuntime: {} });

/* ── The React provider enforces the same contract ────────────────────── */

// `RevTurbineProvider`'s `options` prop is typed
// `TOptions & ExactInitOptions<TOptions> & { user?: … }`. This file is `.ts`,
// not `.tsx` — the typetests project globs `**/*.test-d.ts` — so the prop is
// asserted through the same generic shape rather than through JSX. That tests
// the mechanism, not the element; a JSX-level assertion would need its own
// project and is covered at runtime by the provider's own suites.
declare function acceptsProviderOptions<TOptions extends RevTurbineInitInputOptions>(
  options: TOptions & ExactInitOptions<TOptions>,
): void;

acceptsProviderOptions({ tenantId: 't_1', localRuntime: { playbook } });

const providerOptions = { tenantId: 't_1', localRuntime: { playbook }, notAnOption: true };
// @ts-expect-error - an unrecognized key is rejected at the provider's prop
// shape exactly as at the direct call.
acceptsProviderOptions(providerOptions);
