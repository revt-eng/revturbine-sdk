/**
 * Type-level fixtures for Playbook structural checking (plan 233 REQ-2c).
 *
 * Checked by `tsc` (`pnpm check:types:exact`), not vitest — there is nothing to
 * run. Every `@ts-expect-error` is an assertion: if a line stops erroring, tsc
 * fails with "Unused '@ts-expect-error' directive" and the guarantee is gone.
 *
 * WHY THIS EXISTS. `UnvalidatedConfigArtifact` was `Record<string, unknown>`,
 * and the reason shipped in a comment was wrong: it said a served artifact is a
 * bare record "by necessity". Two errors in one claim.
 *
 *   1. The type was loose because TypeScript widens JSON *module imports* — an
 *      `import playbook from './revturbine.playbook.json'` gets `artifact_type:
 *      string`, not `artifact_type: "playbook"`. That is a build-time
 *      ergonomics problem about imports. It has nothing to do with serving.
 *   2. Widening only affects *literal* types. `plans: unknown[]` is not a
 *      literal type, so requiring the body arrays was always possible. Nothing
 *      was necessary about giving up on the whole shape.
 *
 * The consequence was a real hole: a truncated Playbook — the shape the
 * escalated integration actually served — type-checked at the `localRuntime`
 * boundary and failed at runtime instead. The runtime check in
 * `normalizeConfigArtifactOrThrow` caught it, but only after init.
 *
 * WHAT IS AND IS NOT CHECKED. The required-field list is *derived* from
 * `REQUIRED_BODY_ARRAY_FIELDS`, the same constant the runtime validates
 * against, so the two contracts cannot drift. Header fields stay unconstrained
 * because those are precisely the widened ones. Values are not checked at all —
 * that stays the runtime's job, and always will.
 */
import { initRevTurbine } from './customer-side';
import type { UnvalidatedConfigArtifact } from './config-artifact';

/**
 * A REAL artifact from the cross-language parity corpus, not one written here
 * to pass. A fixture authored alongside the type it validates proves only that
 * the author was consistent; this one is byte-identical to what every port
 * evaluates, and it reaches this file through a JSON module import, so it is
 * genuinely widened.
 */
import fixture from '../tests/parity/fixtures/playbook_dual_read_canonical.json';

/* ── Accepted: the widened JSON import this type exists for ───────────────── */

const fromJsonModule: UnvalidatedConfigArtifact = fixture.playbook;
void fromJsonModule;

// The boundary itself, which is what actually matters — the type is only
// interesting because `initRevTurbine` accepts it.
initRevTurbine({ tenantId: 't_1', localRuntime: { playbook: fixture.playbook } });

/* ── Accepted: the SERVED path is not made harder ─────────────────────────── */

// `await res.json()` is `any`, so fetching a Playbook still compiles with no
// cast and no ceremony. Tightening this type did NOT push cost onto the served
// path — the case that motivated the original (wrong) claim.
declare const servedArtifact: any; // sdk-ok: boundary-parse
initRevTurbine({ tenantId: 't_1', localRuntime: { playbook: servedArtifact } });

// Unknown extra keys are fine: a Playbook carries many optional header fields,
// and new ones must not break an SDK that predates them.
const withExtraHeaderFields = {
  ...fixture.playbook,
  some_future_header_field: 'added by a newer control plane',
};
initRevTurbine({ tenantId: 't_1', localRuntime: { playbook: withExtraHeaderFields } });

/* ── Rejected: a truncated artifact — the escalated shape ─────────────────── */

const truncated = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  tenant_id: 't_1',
  environment_id: 'production',
  plans: [],
  entitlements: [],
  // entitlement_rules, segments and content_ui_paths are all absent.
};

// @ts-expect-error - a truncated Playbook is now a COMPILE error at the
// boundary. Before this change it type-checked here and threw at init.
initRevTurbine({ tenantId: 't_1', localRuntime: { playbook: truncated } });

/* ── Rejected: each required array, one at a time ─────────────────────────── */

// Proves the list is genuinely derived from REQUIRED_BODY_ARRAY_FIELDS rather
// than approximated. A guard that happens to catch one field is not the same as
// one that catches all five, and only checking a single omission cannot tell
// the two apart.

const noPlans = { entitlements: [], entitlement_rules: [], segments: [], content_ui_paths: [] };
// @ts-expect-error - missing `plans`
const a: UnvalidatedConfigArtifact = noPlans; void a;

const noEntitlements = { plans: [], entitlement_rules: [], segments: [], content_ui_paths: [] };
// @ts-expect-error - missing `entitlements`
const b: UnvalidatedConfigArtifact = noEntitlements; void b;

const noRules = { plans: [], entitlements: [], segments: [], content_ui_paths: [] };
// @ts-expect-error - missing `entitlement_rules`
const c: UnvalidatedConfigArtifact = noRules; void c;

const noSegments = { plans: [], entitlements: [], entitlement_rules: [], content_ui_paths: [] };
// @ts-expect-error - missing `segments`
const d: UnvalidatedConfigArtifact = noSegments; void d;

const noUiPaths = { plans: [], entitlements: [], entitlement_rules: [], segments: [] };
// @ts-expect-error - missing `content_ui_paths`
const e: UnvalidatedConfigArtifact = noUiPaths; void e;

/* ── Rejected: a body array that is not an array ──────────────────────────── */

const plansIsAnObject = {
  plans: {},
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
};
// @ts-expect-error - `plans` is present but is not an array. Presence alone was
// never the contract; `requireBodyArrays` asserts `Array.isArray` at runtime.
const f: UnvalidatedConfigArtifact = plansIsAnObject; void f;

/* ── Rejected: the bare record this type used to BE ───────────────────────── */

const bareRecord: Record<string, unknown> = {}; // sdk-ok: type-definition
// @ts-expect-error - the whole point of the change. This is the one genuinely
// breaking case: a caller who annotated their artifact `Record<string, unknown>`
// must now narrow it (or let `res.json()` stay `any`). That is the strengthening
// working, not collateral damage — it is exactly the shape that could carry a
// truncated Playbook to init undetected.
const g: UnvalidatedConfigArtifact = bareRecord; void g;
