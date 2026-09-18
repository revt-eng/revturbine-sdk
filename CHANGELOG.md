# Changelog

Release notes and breaking changes for the RevTurbine SDKs. `@revturbine/sdk` (npm), `revturbine`
(PyPI) and `revturbine` (crates.io) are **version-locked** — they always ship the
same version number, so a version here applies to all three unless an entry says
otherwise.

Verified for `0.8.1`: npm `0.8.1`, PyPI `0.8.1`, crates.io `0.8.1` (2026-09-14).

Every breaking change is recorded in the same shape, because the thing that cost
an integration the most time was not the change itself but not being able to
answer *"which version broke this, and which version made it loud?"*:

| field | what it answers |
|---|---|
| **What changed** | the old shape and the new one, concretely |
| **Landed in** | the version that introduced the change |
| **Fail-closed in** | the version where the old shape stopped being silently tolerated. Often the same version; when it is **not**, the gap is where integrations break quietly. |
| **Proving test** | the test in this repo that would fail if the behaviour regressed |

A change whose "Fail-closed in" is later than its "Landed in" had a window where
the old shape was accepted and did nothing. Those windows are the expensive ones.

> **What this file is not yet.** A CI guard fails any PR that changes a
> `@public`-tagged export signature without touching this file. That tagging is
> thin: as of `0.8.0` it covers **4** methods on `RevTurbineCustomerSdk`, which
> declares roughly **73**. `can()`, `getPlacementDecision()`, `identify()` and
> `dismiss()` are among the untagged, so a breaking change to one of them will
> not be caught automatically — it depends on whoever writes the PR. Entries here
> are reliable; the absence of an entry is not yet proof that nothing changed.

> **Note on 0.x.** These packages are pre-1.0, so breaking changes ship in the
> **minor** position (`0.6.0` → `0.7.0`), not the major. `npm`'s caret on a `0.x`
> range does **not** span minors, so `^0.7.0` will not silently pull `0.8.0`.

---

## 0.9.2

### Public initializer user context

`await initRevTurbine({ user: { id, ...context }, ...options })` from
`@revturbine/sdk` or `@revturbine/sdk/headless` now passes `id` only as the
identity argument. Supported user context retains its existing behavior without
the spurious unrecognized-context-key warning for `id`; genuinely unknown keys
still warn. Public quick starts now show the awaited `SdkSession` and
`session.sdk.getBranding()`. The separate synchronous core initializer is unchanged.

Proving tests: `web-sdk/public-init.test.ts` and the installed public-package
runtime/type examples in `web-sdk/scripts/check-public-diagnostics.mjs`.

## 0.9.1

### Public changelog distribution

The maintained changelog is now included as `CHANGELOG.md` in the npm package
and mirrored at the root of the public SDK repository. The docs Reference
navigation links directly to that authoritative public file. The independent,
hidden docs copy has been retired. The pre-0.3.0 history gap below remains;
this release does not reconstruct it. No SDK runtime behavior changed.

## 0.9.0

### Placement eligibility follows current context after conversion

- **What changed** — Conversion remains an analytics event and no longer retires
  or temporarily suppresses a placement. Legacy conversion-owned browser state
  is ignored. Supply the updated UserContext after a plan change; Playbook
  targeting determines whether the offer still applies.
- **What changed** — Fixed and Access Gate placements bypass dismissal, reminder
  and bare-click cooldowns. Dismiss and snooze close the current display; the
  next explicit trigger, refresh or mount evaluates again. This uses the resolved
  placement category, including when another category renders inside a Fixed slot.
  Other categories retain authored/default windows, and explicit system
  suppression and entitlement denial remain effective.
- **Landed in** — `0.9.0` across JavaScript, Python and Rust.
- **Fail-closed in** — Not applicable; no input shape was removed. Rust callers
  constructing `InteractionState` literals should supply the new optional
  `explicit_suppressed_until` field or use `..Default::default()`.
- **Proving test** — `web-sdk/conversion-eligibility.test.ts`,
  `web-sdk/placements/FixedSurfaceSlot.dismissal.test.tsx`, and the shared
  `placement_category_interactions` parity fixture.

## 0.8.9

### JavaScript: development diagnostics survive package minification

- **What changed** — The SDK package preserves the environment check until the
  consuming application builds it. Previously the minified package baked in
  production mode, hiding the React initialization-failure banner, app-theme
  override warning and legacy-theme warning even in development applications.
  Production applications still suppress those development diagnostics;
  `initStatus` and required initialization-error reporting remain available.
  The existing fallback for browsers without `process` is preserved.
- **Landed in** — `0.8.9`.
- **Fail-closed in** — Not applicable; no decision or initialization policy changes.
- **Proving test** — `web-sdk/scripts/check-public-diagnostics.mjs` installs the
  public tarball and runs Chromium against separate development, production
  and environment-preserving consumer bundles. The PR release-build gate
  retains the tarball, inventory, SHA-256 and observed diagnostics.

Python and Rust receive the matching version bump; their behavior is unchanged.

## 0.8.8

Behavioural fixes in Python; a new decision surface in Rust.

### Python: numeric coercion unified onto JS Number() semantics

- **What changed** — `parse_numberish`'s string branch used Python
  `float()`, which accepts forms JS `Number()` rejects (underscore
  separators: `"1_000"` scored 1000 here, NaN->0 in TypeScript — a
  candidate-flipping divergence in every selection scorer) and rejects
  forms JS accepts (`"0x10"` is 16). The one JS-semantics parser from the
  plan-233 segments port is promoted to `helpers.js_number` and every
  coercion site shares it. Ripple alignments: `Number("")` is 0 (the old
  is-None assertion pinned the float() behaviour), a whitespace-only
  `template_version` resolves to `"0"` exactly as TS does, and
  `superseded_versions` no longer fabricates a `"0"` entry from an empty
  string (mirrors TS's trim-then-filter).

### Rust: the candidate-selection layer, ported

- **What changed** — `resolve_local_placement_from_candidates` plus the
  full helper set (category buckets, plan-53 two-stage tier-3 urgency,
  milestone supersession, category conflict suppression, server-order
  dominance) now exists in Rust (`placements/selection.rs`). Until now the
  Rust port selected by entry order only; competing-category selections
  had no third side, which is why plan 234 TASK-15's fixture was deferred.
- **Proving test** — parity fixture `placement_selection_priority`
  (10 calls: cross-tier dominance, both tier-3 stages including a
  class-vs-proximity disagreement, retention/conversion tie, server_order
  skipping conflict suppression, fixed_only, milestone supersession, both
  REQ-5 coercion lanes, output_id tiebreak), byte-identical ts/py/rs on
  its first regen, plus mirrored port-local suites in Python and Rust.

## 0.8.7

No runtime behaviour change in any port; the release carries new parity
locks and one serde derive.

### All ports: trial-status derivation and allocation scoping parity-locked

- **What changed** — two decision surfaces every runtime already evaluated
  gained their first cross-language locks. `evaluateTrialStatus` (the
  free/reverse trial-rule derivation): the TS golden vectors mirrored the
  Python unit suite by hand-maintained convention, and Rust was never in
  the mirror at all; the `trial_status_evaluation` fixture makes the
  agreement a byte-checked property. `computeConsumedPercent` (the spec
  3.4 Pooling allocation-scoped grant selection): reachable from no
  placement fixture because the static provider has no grants lane; the
  `threshold_allocation_scoping` fixture drives every allocation label
  against a hierarchy whose levels carry DIFFERENT counters.
- **A wire divergence caught on first regen** — the reverse-trial grants
  set serialized three different ways (TS `JSON.stringify(Set)` = `{}`
  with the contents silently lost; Python's canonicalizer dropped the key;
  Rust emitted the honest list). The runners now own the wire form: a
  sorted array on every side.
- **Fail-closed in** — no evaluator changed; `TrialEvaluation` gained a
  `Serialize` derive in Rust (additive).
- **Proving test** — parity fixtures `trial_status_evaluation` (6 calls;
  the usage-lane call was sharpened after the first cut put
  `trial_limit_type` on the RULE and every side agreed on `time` - the
  non-discriminating shape REQ-3 forbids; it rides the INSTANCE) and
  `threshold_allocation_scoping` (9 calls).

## 0.8.6

One capability lands in the two ports; TypeScript is unchanged and ships this
version for lockstep alone.

### Python + Rust: targeting-state derivation ported (buildTargetingState)

- **What changed** — `LocalRuntime.build_targeting_state` raised
  NotImplementedError in Python (a REQ-14 deferral) and had no Rust port at
  all, so the derivation from a raw user context to the traits segment
  evaluation consumes existed only in TypeScript: segment parity proved
  "agrees given the same traits", never "agrees given the same user
  context". Both ports now carry the pure derivation
  (`core.user_context.build_targeting_state` / `user_context.rs`), byte-
  locked against the TS canonical.
- **Also aligned red-first** — Python's dormant
  `configured_plan_name_from_exported_config` (no callers until now) still
  carried pre-plan-120 semantics: id matching, plan-object resolution, and
  a `_handle` suffix fallback. Plans resolve by `unique_handle` alone; the
  drift-pinning tests were corrected with the alignment.
- **Fail-closed in** — identity rules are shadow-proof by construction:
  `plan_handle` is a reserved trait a `custom.plan_handle` can never
  impersonate, and no identity means the reserved trait is REMOVED and the
  effective plan omitted.
- **Proving test** — parity fixture `targeting_state_derivation` (6 calls:
  identity precedence, shadow-proofing, plan-OBJECT fallback, the id that
  must resolve nothing, the no-identity removal, override-wins usage with a
  legacy bare-number entry), byte-identical ts/py/rs, plus the corrected
  unit matrices in both ports.

## 0.8.5

One behavioural alignment, Python only. TypeScript and Rust are unchanged and
ship this version for lockstep alone.

### Python: category buckets and tier-3 urgency aligned to the plan-53 model

- **What changed** — this port's `category_bucket` carried the pre-plan-53
  map for months (trial=3, retention=5 where the canonical folds trial into
  priority tier 3 as bucket 2 and retention into the single discretionary
  bucket 4); its docstring cited source lines that had moved AND changed
  upstream. The map feeds the selection comparator, so a trial and a usage
  placement competing for one surface ordered STRICTLY here (usage always
  first) while the canonical ties them and applies the plan-53 two-stage
  urgency model — which this port also lacked. `tier3_class` is now ported
  and staged ahead of proximity in `resolve_local_placement_from_candidates`,
  the map matches the canonical, and the system-caps exemption boundary moved
  from the compensating `<= 3` to the canonical `<= 2` (the exempted category
  set is unchanged).
- **Landed in** — `helpers.category_bucket` / `helpers.tier3_class`, the
  comparator in `placement_decision.py`, and the caps exemption boundary.
- **Fail-closed in** — no gate changes; this is ordering. Exemptions and
  discretionary classification are set-identical before and after.
- **Proving test** — `tests/placements/test_selection_tier3.py` (class
  ordering with class-vs-proximity DISAGREEMENT cases; mutation-checked:
  disabling the tier3 stage fails exactly the two stage-1 tests), plus the
  bucket-map matrix in `test_helpers.py` whose old strict `usage < trial`
  invariant was pinning the drift. The cross-language fixture for this
  surface lands with the Rust selection-layer port (plan 234 TASK-8).

## 0.8.4

One behavioural alignment, Python only. TypeScript and Rust are unchanged and
ship this version for lockstep alone.

### Python: cap/cooldown maths consolidated onto the shared primitive

- **What changed** — `placement_decision.py` and `cap_enforcer.py` carried
  their own copies of the cap-window and cooldown arithmetic that TypeScript
  consolidated onto `evaluateCaps` (plan 233 TASK-15 / scaffold #351). Both
  now delegate to the new `cap_rules.evaluate_caps` port. Reading the bodies
  side by side surfaced two silent divergences, both aligned to the TS
  canonical: Fixed / Access-Gate categories are now exempt from per-payload
  caps in `check_placement_caps` (TS has exempted them since plan 167; this
  port capped them), and a cap deny now persists the UNFILTERED state — the
  old bodies trimmed `seen_at` to the tripping window (one comment claimed
  "Mirrors TS"; TS does no such trim), silently shrinking future week/month
  windows.
- **Landed in** — `core/placements/cap_rules.py` (the primitive),
  `check_placement_caps` / `check_system_presentation_caps` /
  `CapEnforcer.enforce` (the delegations).
- **Fail-closed in** — verdicts only ever tighten or stay: the exemption
  affects categories that are user-prompted by design, and the state
  alignment preserves more history, never less.
- **Proving test** — `tests/placements/test_cap_delegation.py`: a 12-case
  characterization matrix green before AND after the refactor, the two
  aligned behaviours run RED against the pre-refactor body, and a mutation
  of the shared window arithmetic fails four tests across both entry points
  (the shared maths is reached, not shadowed).

## 0.8.3

One behavioural fix, Rust only. TypeScript and Python are unchanged and ship
this version for lockstep alone.

### Rust: a confirmed conversion did not retire the placement

- **What changed** — the Rust port carried the full ImpressionHistory
  machinery (`record_conversion`, `is_hidden_sync`, the retired cache) since
  the port landed, but its placement resolver never consulted it. A user who
  completed a placement's CTA — a confirmed conversion — kept seeing that
  placement in this port alone, while TypeScript core
  (`local-resolver.ts:610-612`, `:726`) and Python both hide it permanently.
  This is the defect class plan 167's unshipped follow-up became as a
  customer P1: paying customers shown the upsell they already bought.
- **Landed in** — the retirement gate is wired at both decision lanes: the
  candidate filter (before the trigger gates, mirroring the TS order) and
  the direct-lookup path, which now answers `placement_retired`, keyed by
  the output's `rule_id` exactly as TS core and Python key it.
- **Fail-closed in** — the gate only ever hides; an empty or cold history
  changes nothing, and a placement with no recorded conversion is untouched.
- **Proving test** — parity fixture `placement_conversion_retires`
  (visible -> convert -> `placement_retired`, with an untouched control
  staying visible, byte-identical across ts/py/rs; mutation-checked: making
  the Rust gate inert diverges the snapshot) and
  `server-rust/tests/local_runtime.rs`
  (`a_confirmed_conversion_permanently_retires_the_placement`).

## 0.8.2

One behavioural fix, Rust only. TypeScript and Python are unchanged and ship
this version for lockstep alone.

### Rust: provider-path rule selection was source-order, not most-permissive

- **What changed** — on the provider path (`check_entitlement` with a rules
  provider, the path a static config registers), the Rust port's §2.6.5
  most-permissive selection scored each rule snapshot's root object instead
  of its `fields` sub-object, where the adapter actually nests the score keys
  (`limit_value`, `allowance`, `included_count`, `enabled`). Every rule
  scored 0, so the deterministic tie-break — earliest in source order —
  silently decided instead. Concretely: an entitlement carrying both a seat
  rule (listed first) and a `usage_limit` rule at limit 2 returned **allowed**
  at `used: 3` where TypeScript and Python return limited
  (`usage_limit_reached`). Whether you were affected depends on rule order in
  your Playbook, which is what made this silent. The ExportedConfig fallback
  path (`derive_local_entitlement_from_configured_rules`) was NOT affected —
  it passes the merged type-fields bag and scored correctly.
- **Landed in** — `0.8.2`.
- **Fail-closed in** — `0.8.2` (same release; no tolerated window).
- **Proving test** — parity fixture `entitlement_rule_seat_included_count`
  (byte-locked ts ≡ py ≡ rs; diverged on exactly the shadowed-limit call until
  the fix) and `most_permissive_scores_the_fields_sub_object_not_the_snapshot_root`
  (Rust unit, mutation-checked). The pre-existing Rust unit test had authored
  its score key at the snapshot root — a shape the adapter never emits — and
  passed over the bug; it now uses the production shape.

---

## 0.8.1

One behavioural fix, Python and Rust only. The TypeScript SDK is unchanged and
ships this version for lockstep alone.

### Python/Rust: cross-dimension segment AND no longer degrades to flat OR

- **What changed** — the config evaluator's segment→dimension lookup was keyed
  by the segment's `id` in the Python and Rust ports, where the TypeScript
  canonical keys it by `handle`. Rule `segment_ids` are handle-valued, so on
  any Playbook whose segment ids differ from their handles — every real
  export — the ports' lookups all missed, every rule segment collapsed into
  the uncategorised bucket, and a rule spanning two dimensions (which must
  require BOTH, intra-dimension OR + cross-dimension AND) matched on EITHER.
  Concretely: an entitlement rule scoped to `emea` (region) AND `admins`
  (role) **granted** a user who was only in `emea`. It now denies, matching
  the TypeScript SDK. If your integration passes a non-empty user segment set
  to `derive_local_entitlement_from_configured_rules` and relies on a
  cross-dimension rule, users who matched only one dimension lose the grant
  on upgrade — that is the fix working. The built-in runtime fallback path
  passes an empty segment set and is unaffected.
- **Landed in** — `0.8.1`.
- **Fail-closed in** — `0.8.1` (same release; no tolerated window).
- **Proving test** — parity fixtures `entitlement_segment_dimensions` /
  `entitlement_segment_no_dim_bucket` (byte-locked TS ≡ Python ≡ Rust; the
  regen diverged on exactly the cross-dimension calls until the fix), plus
  `TestSegmentDimensionLookup` (Python) and `cross_dimension_and_*` (Rust).

## 0.8.0

Plan 233 remediated four escalated defect families, and this is the release that
delivers them. Everything below sat merged on `main` and unpublished for the
length of that plan — 20 commits, twelve breaking changes — because the version
never moved off `0.7.13`.

**Read this section before upgrading from `0.7.x`.** Three of these change live
behaviour rather than only types: segment-targeted payloads stop showing to
users outside the segment, `sdk.dismiss()` starts writing suppression where it
previously did nothing, and a converted placement stops coming back. Each is the
fix working, and each is visible to your users the moment you upgrade.

### The `tenantId` init option is now the authority over a Playbook's `tenant_id`

- **What changed** — the Playbook's `tenant_id` used to win, and the init option
  was a fallback applied only to legacy artifacts. That combination killed every
  integration that served a canonical Playbook *and* passed the tenant at init:
  the artifact had no `tenant_id` to win with, and the option was withheld
  because the artifact was canonical, so init threw. The init option now wins.
  The artifact's `tenant_id` is a **guard** — it exists so the CLI can refuse to
  upload a config to the wrong tenant — and on a mismatch the SDK warns, naming
  both values, and proceeds. It never fails init.
- **Landed in** — `0.8.0`
- **Fail-closed in** — n/a. This change makes init *succeed* where it used to
  throw. The old behaviour was the failure.
- **Proving test** — `web-sdk/config-target-precedence-init.test.ts`

### Unrecognized and missing init options are compile errors

- **What changed** — init options are exact-checked. A typo (`apikey` for
  `apiKey`) or a stale option is a type error rather than a value the SDK
  silently ignores. This catches the case TypeScript's excess-property check
  never saw: options assembled in a variable, or in an un-annotated `useMemo`,
  which is exactly how React integrations build them.
- **Landed in** — `0.8.0`
- **Fail-closed in** — same. Unknown keys were ignored at runtime before and
  still are; what changed is that you cannot write them.
- **Proving test** — `web-sdk/init-options-exactness.test-d.ts`

### A truncated Playbook is a compile error at the `localRuntime` boundary

- **What changed** — `UnvalidatedConfigArtifact` was `Record<string, unknown>`
  and now structurally requires the body arrays (`plans`, `entitlements`,
  `entitlement_rules`, `segments`, `content_ui_paths`). A Playbook missing one is
  now caught by `tsc` instead of throwing at init.
- **Who this breaks** — only a caller who **explicitly annotated** their artifact
  `Record<string, unknown>`; that must now be narrowed. A JSON module import and
  a fetched artifact (`await res.json()`, typed `any`) both still compile with no
  cast.
- **Landed in** — `0.8.0`
- **Fail-closed in** — same version, at compile time. Runtime validation was
  already fail-closed and is unchanged.
- **Proving test** — `web-sdk/playbook-structural.test-d.ts`

### Init failure is observable without an SDK instance

- **What changed** — when init fails the provider used to log and render children
  anyway, so the SDK simply never started and every diagnostic probe was
  unreachable *in precisely the failure mode that matters most*. `initStatus` is
  now on the React context and is readable when the SDK instance is `null`, with
  a non-empty `remediation` string on every init-path error.
- **Landed in** — `0.8.0`
- **Fail-closed in** — same.
- **Proving test** — `web-sdk/react/RevTurbineProvider.init-status.test.tsx`

### The rendered theme resolves through the branding ladder

- **What changed** — `RevTurbineProvider` read `playbook?.theme` directly, so the
  `branding` init option never reached `useRevTurbineTheme()`. `getBranding()`
  and the rendered theme disagreed; that divergence *was* the defect. Both now
  resolve from the same rung.
- **Landed in** — `0.8.0`
- **Fail-closed in** — same.
- **Proving test** — `web-sdk/react/RevTurbineProvider.branding-ladder.test.tsx`

### `RevTurbineThemeProvider` merges partial themes, and an app-mounted one wins

- **What changed** — a partial theme replaced the defaults wholesale instead of
  merging, so supplying one token dropped every other. Partial themes now merge.
  Separately: if your app mounts its own `RevTurbineThemeProvider`, it wins over
  the SDK's internal default, and a conflict warns in development.
- **Landed in** — `0.8.0`
- **Fail-closed in** — same.
- **Proving test** — `web-sdk/theme/ThemeContext.partial.test.tsx`,
  `web-sdk/react/RevTurbineProvider.theme-nesting.test.tsx`

### Light/dark schemes no longer require re-initializing the SDK

- **What changed** — additive. A `colorScheme` option and `setColorScheme()` swap
  palettes while keeping SDK instance identity stable. The previous workaround
  was re-initializing the SDK, which discarded its state.
- **Landed in** — `0.8.0`
- **Fail-closed in** — n/a, additive.
- **Proving test** — `web-sdk/react/RevTurbineProvider.color-scheme.test.tsx`

### `segment_chips` are enforced in the decision path

- **What changed** — payload `segment_chips` were evaluated by
  `explainPlacementDecision` but **not** by the decision path itself, so the
  probe and the decision disagreed and a segment-targeted payload could show to a
  user outside the segment. Both now call one shared helper, in every port.
- **Who this breaks** — an integration relying, knowingly or not, on
  segment-targeted payloads showing to everyone will now see them correctly
  restricted. **There is no grace period**: this was ruled a bug, not a behaviour
  change.
- **Landed in** — `0.8.0`
- **Fail-closed in** — same version, and in all three runtimes together.
- **Proving test** — `tests/parity/fixtures/segment_chip_targeting.json` and
  `tests/parity/fixtures/segment_evaluation.json`, run byte-identical across
  TypeScript, Python and Rust.

### Dismissal actually suppresses, at the authored window

- **What changed** — two defects. The interaction-state **read** omitted
  `treatmentId` while the **write** included it, and the controllers always
  populate it, so the keys could never match and dismissal suppression was dead
  for every React integration. And the window was a hardcoded 24-hour literal
  passed explicitly at every call site, which made both the authored
  `cooldown_after_dismiss_days` and the 7-day default unreachable. The window now
  resolves: explicit caller value → **authored config** → SDK default.
  `remind_later_minutes` resolves independently, so "remind me" no longer means
  "hide for a week".
- **Who this breaks** — dismissal now suppresses where it previously did nothing.
  An integration that layered its own suppression on top may double-suppress.
- **Landed in** — `0.8.0`
- **Fail-closed in** — same. Note the *shape* of this one: it shipped in plan 167
  with a proving test that dismissed **without** a `treatmentId`, so both keys
  fell back to `'default'`, matched, and the feature appeared to work for a
  month.
- **Proving test** — `web-sdk/customer-side-cooldown-suppression.test.ts`

### A dismissal is no longer treated as "no match"

- **What changed** — `FixedSurfaceSlot` rendered its `fallback` whenever
  `!visible`, and dismissing sets `visible: false` — so closing a placement put
  the fallback back in the same space, a ghost replacing the thing just
  dismissed. A slot now distinguishes the two: no match still renders `fallback`;
  a dismissal renders nothing. `FixedSurfaceSlot` also gains `onDismissed`, and
  `MessageSurfaceSlot`'s `onDismissed` — a public prop whose handler was built
  and then discarded, so it could never fire — now works.
- **Who this breaks** — a host working around the ghost (one integration used a
  `MutationObserver`) can remove the workaround. `MessageSurfaceSlot`'s
  `onDismissed` goes from never firing to firing.
- **Landed in** — `0.8.0`
- **Fail-closed in** — same.
- **Proving test** — `web-sdk/placements/FixedSurfaceSlot.dismissal.test.tsx`

### `convert()` retires the placement instead of only reporting it

- **What changed** — `convert()` emitted a `placement_interaction` event and
  stopped: it never wrote the terminal state, so **a user who converted kept
  being shown the upsell they had just paid for**. `dismiss()` and `snooze()` had
  the identical report-but-never-act shape. All three now route through
  `trackTreatmentInteraction`.
  A second defect sat behind the same symptom: nothing in the decision path ever
  *read* the terminal state. `isRetired` was written by `recordConversion` and
  had no caller, so a 5-minute transient window was the only thing hiding a
  converted placement — the upsell returned five minutes after checkout even
  through the controller path. `getPlacementDecision` now checks retirement and
  answers `retired_by_conversion`.
- **Who this breaks** — `sdk.dismiss()` now writes suppression state where it
  previously did nothing.
- **Landed in** — `0.8.0`
- **Fail-closed in** — same.
- **Proving test** — `web-sdk/convert-retires-placement.test.ts`

### New: a slot-inventory probe

- **What changed** — additive. `sdk.getRegisteredSlots()` returns the slots this
  app has mounted, and `sdk.diagnoseSlotInventory()` diffs them against the
  Playbook's placement triggers in both directions. A placement targeting a slot
  no code mounts **can never show** and nothing reported it; a config-side audit
  cannot see call sites.
- **Landed in** — `0.8.0`
- **Fail-closed in** — n/a, additive and diagnostic.
- **Proving test** — `web-sdk/slot-inventory-probe.test.ts`

---

## 0.7.0

### `soft_block` → `block_with_upsell`

- **What changed** — the enforcement mode `soft_block` was renamed to
  `block_with_upsell`, and with it the reason codes the SDKs return:
  `usage_limit_reached_soft_block` → `usage_limit_reached_block_with_upsell`, and
  `credit_balance_exhausted_soft_block` → `credit_balance_exhausted_block_with_upsell`.
  **Any integration branching on the old reason string stops matching.**
- **Landed in** — `0.7.0`
- **Fail-closed in** — n/a. Behaviour is unchanged, and `soft_block` is still
  accepted wherever it appears in an already-compiled Playbook, decoding to
  exactly the decision it always made. Existing payloads keep working without
  recompilation; only the **string you match on** moved.
- **Proving test** — the cross-language parity corpus (`tests/parity/`), which
  asserts the reason codes byte-identically across all three runtimes.

---

## 0.6.0

### The server-side decision methods are gone

- **What changed** — removed `RevTurbineServer.evaluate` / `getPlacement` /
  `checkEntitlement` / `can` / `getTrialStatus` (Node), and the whole
  `revturbine_server` module (Python).
- **Why the breakage is nominal** — every removed method called a hosted decision
  endpoint that no longer exists, so each had been returning a **network error**
  since that endpoint was deleted, in two languages, unnoticed — because the
  cross-port gate only ever asked whether a method of that *name* existed.
- **What stays** — `RevTurbineServer` itself, and `createClientSession()`, which
  mints the browser-safe token the client SDK's `clientSession` callback
  consumes. An integration using the class only for that is unaffected.
- **Replacement** — evaluation is a pure function of (user context, Playbook) and
  runs in the SDK. Use `LocalEvaluationServer` (Node) or `RevTurbineCustomerSdk`
  (Python).
- **Landed in** — `0.6.0`
- **Fail-closed in** — effectively before `0.6.0`: the methods were already
  erroring. `0.6.0` made the failure a compile/import error instead of a runtime
  one.
- **Proving test** — `tests/no-decision-endpoint.test.ts`

---

## 0.5.0

### The access gate denies during server rendering

- **What changed** — the gate is constructed inside a `useEffect`, and effects do
  not run during SSR. So on the server there was no gate at all: `isLoading` read
  false, `result` was null, `denied` computed false — and the gate emitted its
  **children**. The server-rendered HTML for a gated feature was literally the
  paid affordance. It now denies until a real verdict exists.
- **Why this one mattered** — it is a fail-open in the one place the client
  cannot correct it. A crawler or a reader that never runs JS sees the paid
  content.
- **Landed in** — `0.5.0`
- **Fail-closed in** — `0.5.0`. This *is* the fail-closed change.
- **Proving test** — `web-sdk/placements/AccessGateSurfaceSlot.ssr.test.tsx`

---

## 0.4.0

### An unresolvable plan identity denies in Python and Rust

- **What changed** — the headless ports granted where TypeScript denied when a
  user context carried no resolvable plan identity. The ports now deny, matching
  TypeScript.
- **Landed in** — `0.4.0`
- **Fail-closed in** — `0.4.0` for Python and Rust; TypeScript already denied.
  **The window between `0.3.0` and `0.4.0` is the expensive one** — a context
  that failed closed in TS silently granted in the other two runtimes.
- **Proving test** — the cross-language parity corpus, which is what surfaced the
  divergence: the gate had been green while `deriveLocalEntitlementFromConfiguredRules`
  sat unreached by any fixture.

---

## 0.3.0

This release is where the `plan: { id }` → `plan_handle` migration landed. It was
a **minor** bump carrying breaking changes, authorised because there were no
active tenants and only in-org code referenced the changed surfaces.

### `plan: { id }` → `plan: { handle }` / `plan_handle`

- **What changed** — a plan's matching identity is its `unique_handle`.
  `plan.id` is DB-internal and no longer participates in matching anywhere, in
  any of the three runtimes.
- **Symptom if you do not migrate** — a context whose only plan signal is
  `plan.id` now matches **no** plan-targeted rule and fails closed. It does not
  error; it simply has no plan.
- **Landed in** — `0.3.0`
- **Fail-closed in** — `0.3.0`.
- **Proving test** — `web-sdk/user-context-exactness.test-d.ts` plus the
  plan-identity parity fixtures
  (`tests/parity/fixtures/entitlement_plan_identity_is_handle.json`,
  `entitlement_no_plan_identity_denies.json`).

### `identify()` no longer accepts an arbitrary traits bag

- **What changed** — unknown top-level context keys are a compile error.
  Free-form values go under `custom`, via `update()`.
- **Landed in** — `0.3.0`
- **Fail-closed in** — `0.3.0`, at compile time.
- **Proving test** — `web-sdk/user-context-exactness.test-d.ts`

### `local_runtime_default_allow` → `entitlement_not_in_playbook`

- **What changed** — the reason code was renamed with **no deprecated alias**,
  and the headless runtimes' terminal fallback now **denies** where it used to
  grant.
- **Landed in** — `0.3.0`
- **Fail-closed in** — `0.3.0`. The rename and the fail-closed flip shipped
  together, deliberately: the old name described a grant, so keeping it as an
  alias would have described the new behaviour incorrectly.
- **Proving test** — the fail-closed suites in `web-sdk/` and the corresponding
  Python and Rust port suites.

---

## Before 0.3.0

Versions `0.1.0` through `0.2.91` predate this changelog. Breaking changes in
that range are recorded only in commit history and release notes. If you are
upgrading from `0.2.x`, read the `0.3.0` section first — it is the release that
changed plan identity, and it is the one most likely to affect you.
