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
> `@public`-tagged export signature without touching this file. That tagging
> was thin (4 of ~73 methods) until BL-0005 (2026-09-22, no release — TSDoc
> and snapshot only) widened it to **34** of `RevTurbineCustomerSdk`'s **67**
> non-private methods, plus 5 provider/hook entry points
> (`initRevTurbine`, `RevTurbineProvider`, `useCan`, `useEntitlement`,
> `useGatedAction`) — every method a customer-facing guide, skill, the
> starter, or a demo app calls directly. The remaining ~33 methods are
> internal-only paths (called only by the SDK's own placement components,
> React bindings, or other internal packages) and stay untagged, so a
> breaking change to one of *those* still will not be caught automatically —
> it depends on whoever writes the PR. Entries here are reliable; the absence
> of an entry for a currently-untagged method is not yet proof that nothing
> changed.

> **Note on 0.x.** These packages are pre-1.0, so breaking changes ship in the
> **minor** position (`0.6.0` → `0.7.0`), not the major. `npm`'s caret on a `0.x`
> range does **not** span minors, so `^0.7.0` will not silently pull `0.8.0`.

Built-in decision reason values have a separate reviewed
[compatibility baseline](docs/reason-code-contract.md). Live fixture checks
protect those values independently of `@public` method tags; baseline changes
also require a changelog entry.

---

## 0.11.11

### Built-in segment dimensions: reserved `rt_*` segment traits (BL-0310/BL-0311, plan 279 TASK-3/TASK-4)

**What changed.** The user context gains an optional `builtin_dimensions` object with the
built-in segment dimension values: `activity_level`, `subscription_state`, `trial_type`,
`seat_type`, `buyer_role`, `email_type`, `billing_health`, `region` and `device_type`.
Targeting-state derivation (`buildTargetingState`, Python `build_targeting_state`, Rust
`build_targeting_state`) now:

- always stamps `rt_registration_state`: `registered` when the context has a non-empty
  `id`, otherwise `unregistered`;
- stamps each other `rt_<dimension>` segment trait **only** from an in-vocabulary
  `builtin_dimensions` value. An absent or unknown value stamps nothing, so every
  built-in segment of that dimension fails closed;
- **deletes** any `rt_*` key that arrives through `custom`, `entitlements`, usage
  entries or usage overrides. `rt_` is now a reserved trait-key prefix, like
  `plan_handle`.

Before this release, an app trait named `rt_<anything>` reached segment evaluation. It is
now removed. Python and Rust also export the new helpers: `derive_builtin_dimension_traits`,
`is_reserved_trait_key`, `BUILTIN_DIMENSION_VOCABULARIES` and `BUILTIN_TRAIT_KEY_PREFIX`.
Contract: targeting-studio-ui.md §4.1 "Built-in segment resolution contract".

**Landed in:** 0.11.11 (all three ports, `@revt-eng/core` 0.1.359).
**Fail-closed in:** 0.11.11. A custom `rt_*` trait is dropped from the first version that
reserves the prefix.
**Proving test:** parity fixture `tests/parity/fixtures/builtin_dimension_traits.json`
(ts == py == rs) with `tests/parity/builtin-dimension-chain.test.ts`, plus
`server-python/tests/test_builtin_dimension_traits.py` and the
`user_context::builtin_dimension_tests` Rust module.

## Unreleased (no version bump — docs and TSDoc only)

### `RevTurbineServer` documents `apiKey` as the server key (BL-0107, plan 256 TASK-4)

**What changed.** The control plane's `POST /api/sdk/client-sessions` now accepts
the customer's **server key** (`rtk_…`, type `server`) as the minting authority;
the separate `rt_secret_` mint secret it used to require was never issuable and
is retired (revturbine-web, plan 256 TASK-2/3). `RevTurbineServer`'s TSDoc,
`server-node/README.md` and the `@revt-eng/sdk/server` example now say so: pass
the server key as `apiKey`, read from `REVTURBINE_API_KEY` (was
`REVTURBINE_SECRET_KEY`). The examples also now call
`createClientSession({ subject })` and read `client_token` — the shapes the
method has always had (the old examples passed `userId` and read `token`).

**Landed in:** no release — no signature changed; the `apiKey` option already
existed and already sent the server key as the Bearer.
**Fail-closed in:** n/a — no customer-visible behaviour changed in this package.
**Proving test:** `tests/server-node-client-sessions.test.ts` (mints via the
endpoint with the key as Bearer; the key never reaches errors or the console).

## 0.11.9

### The SDK can record app-owned trial revisions and evidenced account creation (BL-0237, plan 276 TASK-13)

**What changed.** Three new `@public` methods on `RevTurbineCustomerSdk` and the
matching capability on the Python and Rust ports:

| Method | Does |
|---|---|
| `recordTrialRevision(episode, labels?)` | Classifies one trial episode's facts and emits one `trial_revision` if — and only if — the evidence supports a revision |
| `syncTrialRevisions(labels?)` | Does the same for every episode the registered `'trial'` domain provider states |
| `recordAccountCreated(payload)` | Emits `account_created` with plan 276 REQ-3 evidence; refuses a user-grain source |

**Trial execution and ownership stay with your app.** RevTurbine runs no trial,
enrols nobody, and decides nothing about when a trial ended. There is no
trial-enrollment service and no server-side evaluation. These methods *record*
the fact your app states, after running the same pure classifier every
RevTurbine port runs — so the fact that reaches the warehouse agrees with the
fact your app believes.

**The classifier reads no clock.** An episode whose scheduled end has merely
passed emits **nothing** and comes back `pending_unknown`. An elapsed deadline
proves only that the time passed, never that your app ended anything — supply
`actual_end_at` plus an `end_evidence` when it did. A conversion links only its
own episode's commitment, at or after that evidenced end, so card collection at
enrolment and unrelated paid activity cannot convert a trial. A usage-metered
episode needs exhaustion evidence before it can expire.

**The gentle nudge.** Registering no `'trial'` provider is a perfectly valid
integration: nothing breaks, no decision changes, every trial keeps working. But
trial revisions then go unrecorded, so the SDK logs **one** info-level console
line per runtime the first time trials exist and nothing will record them:

> `[RevTurbine] No trial provider supplied; trial revisions will not be recorded — see https://docs.revturbine.com/sdk/trials. Register a domain provider with domain: 'trial', or call recordTrialRevision(episode) yourself. Trials keep working; only the lifecycle facts are missing.`

It fires from `setTrialInstances()` (the moment your app hands the SDK trials)
and from `syncTrialRevisions()`. It is never a warning and never an error.

**Local mode.** In `local_only` the SDK makes no server calls at all, so a
recorded revision reaches any registered event consumer and never RevTurbine.
The result says `recorded_locally` rather than `recorded`, so an integrator can
tell the difference instead of assuming the warehouse has it.

**The ports.** `revturbine.core.trials.record_trial_revision` (Python) and
`revturbine::trial_revision::record_trial_revision` (Rust) classify an episode
and return the **validated payload for the host to ship** through its existing
ingest path. They emit nothing themselves: the server ports have never held an
event transport, and adding one would make each a second, unversioned ingest
client. What they guarantee is that the payload is byte-identical to the browser
SDK's for the same facts, asserted by the
`trial_revision_classification` cross-language parity fixture.

| field | value |
|---|---|
| Lands in | `0.11.9` |
| Fails closed in | n/a — additive. No existing call site changes behaviour. |
| Action needed | None to keep working. To record trial lifecycle facts, register a `'trial'` domain provider or call `recordTrialRevision` where your app changes a trial. |
| Proven by | `web-sdk/trial-revision.test.ts`, `tests/parity/fixtures/trial_revision_classification.json` (ts/py/rs), scaffold `src/trials/models/trial-revision.test.ts` |

Requires `@revt-eng/*` **0.1.352**, which adds the `trial_revision` taxonomy
name, the `TrialRevisionPayload` / `AccountCreatedPayload` contracts and the
`classifyTrialRevision` classifier.

---

## 0.11.8

### `account_id` falls back to a PREFIXED user key instead of a bare user id (BL-0117)

**What changed.** Every clickstream event the SDK sends to `/api/track` used to
carry `account_id: userContext.account_id || userId`. `TrackEvent.account_id`
was a required, min-length-1 field, so an app that identified no account had to
send *something* — and what it sent was the **user** id, bare and
indistinguishable from a real account. `monetization_funnel` and `cohort_rollup`
build their account map out of `events_clickstream.account_id`, and experiment
analysis reads that column whenever `analysis_unit = 'account'`: every such row
contributed a bogus `user_id → user_id` account, so an account-grain readout
returned a user-grain n while looking perfectly valid. The treatment-interaction
lane had the same hole from the other side — the SDK sent no `account_id` at all
and the ingest route's own `account_id ?? user_id` fallback stamped a user id
into `placement_presentations.account_id`.

Kent ruled on it, 2026-09-25 (**D-13**): *"Keep the user-id fallback but
explicitly prefix it to make it obvious its a fallback key."*

So the fallback stays — a row with no identified account still needs an
attribution handle, and a hole in a join key is not an improvement — but it is
now **self-describing**:

```text
identified account   →  account_id: "acct_acme"
no account           →  account_id: "user-fallback:user_123"
```

Both wire lanes (`/api/track` → `events_clickstream.account_id`, and
`/api/events/interactions` → `placement_presentations.account_id`) resolve the
value through one private helper, so they cannot drift apart: the funnel joins
one against the other, and a divergence in trimming, hashing or fallback
derivation joins nothing. The fallback is derived from the same
`userContext.id || anonymousId` the row's `user_id` comes from and redacted the
same way, so an email-shaped user id is the SAME hash behind the marker on both
lanes. A blank or whitespace-only `account_id` is not an account and falls
through to the fallback.

Two new `@public` exports carry the contract to integrators and to anything
reading the warehouse:

```ts
import { FALLBACK_ACCOUNT_ID_PREFIX, isFallbackAccountId } from '@revturbine/sdk';

FALLBACK_ACCOUNT_ID_PREFIX;                       // 'user-fallback:'
isFallbackAccountId('user-fallback:user_123');    // true  — fabricated
isFallbackAccountId('acct_acme');                 // false — a real account
```

`isFallbackAccountId` is position- and case-sensitive by contract, matching the
read-time SQL guards: an account id that merely *contains* the marker is a real
account, and the bare prefix with nothing after it is not a key at all. The same
constant and predicate ship in `server-python`
(`revturbine.core.account_identity`) and `server-rust`
(`revturbine::account_identity`, re-exported at the crate root), and the
cross-language parity corpus drives all three
(`tests/parity/fixtures/account_id_fallback_prefix.json`) so the literal cannot
drift between ports.

**Absence is still valid on the wire.** `@revt-eng/schema` 0.1.325 (scaffold
[#375](https://github.com/revt-eng/revturbine-scaffold/pull/375)) made
`TrackEvent.account_id` optional, and web migration 014 made
`events_clickstream.account_id` nullable — absence means "no account
identified", and a producer with no user identity to derive from may still omit
the field. The browser SDK always has an identity (an un-identified visitor
still has the anonymous id), so its default emit always sends the prefixed
fallback rather than a hole.

No public API change to an existing signature: nothing moved, and nothing new is
asked of the caller. `identify(userId, { account_id })` is still the only way to
supply an account. Integrations that identify one see no wire change at all.

**Read-time consequence, stated plainly.** Account-grain analytics exclude
fallback-prefixed ids from account denominators, so an app that never identifies
an account now reports **zero** accounts rather than one-per-user. That is a
correction, not a regression — those rows were never accounts — but a dashboard
that silently read them as account-grain will show a drop.

**Landed in** `0.11.8`. **Fail-closed in** `0.11.8` — the bare fallback is gone
in the same version that introduced the prefixed one; there is no window where
both shapes are emitted.

**Proving test:** `web-sdk/account-identity.test.ts` (the literal, the
classifier's position/case sensitivity, and the bare-prefix and absence cases)
plus `web-sdk/interaction-wire-contract.test.ts` — "the account identity on the
/api/track wire" and "the account identity the analytics joins key on": an
identified user with no account produces `user-fallback:<user_id>` on both
lanes, the prefix survives `/api/track` JSON serialization byte-for-byte, an
identified account reaches the wire byte-identically to the value supplied, a
blank account id is treated as absence, an un-identified visitor derives from
the anonymous id, and every body parses against the canonical
`TrackEventSchema` / `TreatmentInteractionInputSchema`. Also
`web-sdk/customer-side-ingest.test.ts` on the plain `capture()` path,
`server-python/tests/test_account_identity.py`, the unit tests in
`server-rust/src/account_identity.rs`, and the three-way parity fixture.

## 0.11.7

### A rebuilt gate/slot re-runs its check, so a page inside `<Gate>` no longer renders blank (BL-0251)

**What changed.** `RevTurbineProvider` re-initializes and publishes a **new**
`sdk` instance whenever its `options` prop changes identity, with `isReady`
staying `true`. Hosts do this routinely: options derived from an async session
change once, shortly after first paint.

`useEntitlement` rebuilt its `EntitlementGate` on that change, but the effect
that *runs* the check keyed on `[autoCheck, isReady, handle, contextKey]` — none
of which move when only `sdk` does. The replacement gate was therefore never
checked, and an unchecked gate reports `result: null` with `isLoading: false`,
which `<Gate>` reads as *unresolved* and renders as `null`. A page whose whole
body sits inside a `<Gate>` rendered **nothing**, permanently, until the gate was
remounted — which is why navigating away and back "fixed" it and a hard refresh
hit it every time (the session settles after the gate mounts).

`usePlacement` had the same defect: `loadDecision` was memoized on
`[isReady, resolvedUserId]`, so a controller rebuilt for a new `sdk` **or** a
changed slot config was never loaded and the slot stayed empty for the life of
the mount.

Both auto-run dependency lists are now supersets of the lists that rebuild the
object they act on (`sdk` added to both; `placementKey` added to
`loadDecision`). No retry, no polling — the trigger simply covers every reason
the underlying object was replaced.

**Landed in.** `0.11.7`.

**Fail-closed in.** n/a — this was a fail-**blank**, not a tolerated old shape.
Nothing a host passes changes.

**Proving test.** `web-sdk/placements/AccessGateSurfaceSlot.sdk-rebuild.test.tsx`
and `web-sdk/react/usePlacement.sdk-rebuild.test.tsx`.

## 0.11.6

### `sdk.convert()` reloads the UserContext, so a mounted slot re-decides (BL-0004)

**What changed.** `sdk.convert(outputId)` used to record the conversion and stop
there. Conversion writes **no** cooldown and **no** permanent retirement — by
design (Kent's plan 254 D-9 ruling; the `convert` row of the spec's interaction
table) — so eligibility is a function of the user's CURRENT plan and targeting.
That left a real gap: a host that called the public convert path while the
placement was mounted saw the upgrade banner stay on screen until the slot next
happened to resolve a decision. The documented workaround was a manual
`refresh()` or the component's `ctaComplete()`. Plan 236 TASK-13 recorded it as
an open product call rather than asserting it away.

Kent ruled on it, 2026-09-25: *"Converting should trigger a reloading of
UserContext with the new plan/billing state the user has converted to."*

So `convert()` now, after recording the interaction:

1. **Optimistically** moves the held plan when the converted output's CTA names
   one (`cta_path.plan_handle` — e.g. `open_checkout` with `config.purchase`).
   The Playbook supplies the plan's display name when it knows it.
2. Notifies user-context subscribers **either way** — a CTA that names no plan
   still re-decides mounted surfaces.
3. **Then** refreshes from `GET /api/sdk/client-context`, which overlays the
   RevTurbine-authoritative trial / billing-health / plan fields. Best-effort and
   never throwing, exactly as before; a no-op when no client-session minter is
   configured.

Optimistic-first because billing truth arrives by Stripe webhook: a
`client-context` read that races the webhook still reports the OLD plan, and
waiting for it would leave the upgrade prompt up at the exact moment the user
paid. For the same reason, while a conversion is pending a server plan **equal to
the plan converted away from** is dropped (plan fields only — trial and
billing-health always apply). Any other value clears the pending state and
applies, so the suppression cannot outlive the lag it covers.

Mounted `PlacementController`s re-decide and mounted `EntitlementGate`s re-check
through `watchUserContext()`. The React bindings attach it for you
(`usePlacement`, and so every surface slot built on it; `useEntitlement` /
`useCan` already did), and `SdkSession.placement()` / `.entitlement()` attach it
for headless consumers. `dispose()` drops it. `PlacementController.ctaComplete()`
is unchanged.

**What did NOT change.** `convert()`'s signature. Conversion still writes no
suppression and no retirement: back on the old plan, the placement is eligible
again. The optimistic plan move is a session-local overlay, not a new source of
plan truth — a host that re-declares `plan_handle` on mount wins, and that is the
intended precedence.

**Landed in.** `0.11.6` (BL-0004; refs BL-0177, BL-0179 for the re-decide
mechanism this reuses).

**Fail-closed in.** `0.11.6` — same version. Nothing was silently tolerated
before: the old behaviour was a placement that stayed visible, which is why the
limitation was documented rather than dated.

**Proving test.** `web-sdk/convert-reloads-user-context.test.ts` (headless: the
mounted controller's decision goes invisible, a failed conversion moves nothing,
a CTA with no plan still notifies, and the stale-server-plan guard both
suppresses and releases); `web-sdk/react/convert-reloads-user-context.test.tsx`
(a mounted `usePlacement` banner disappears in place and a mounted `useCan` gate
flips denied → granted, with no remount); `e2e/journey.spec.ts` BL-0004 legs (a
real browser: the converted placement leaves the screen with **no** page
refresh, and the optimistic overlay does not outrank the host's declaration).

**Ports.** No change. The Python and Rust SDKs are synchronous-with-config and
have no mounted surfaces to notify; they expose no `convert()` and no
UserContext-reload API, so there is no port-side behaviour to match. The
decision-level contract they do share — a context carrying the new plan yields
decisions for that plan — is unchanged, so no parity fixture moves.

---
## 0.11.5

### `registerSurfaceSlot()` no longer writes to the control plane (BL-0197)

**What changed.** Outside `local_only`, `registerSurfaceSlot()` used to mirror
every slot to the server: `upsertSurfaceSlot()` PUT a legacy surface-slot body
(`{name, slug, slot_type, status, targeting_rules, content, priority,
metadata}`) to `/api/placements/<slot id>`, then POSTed it to `/api/placements`
on the 404. `/api/placements` is RevTurbine's **authored-config** CRUD; it
validates against `PlacementSchema`, which requires `handle` and `category`, so
that body could only ever be rejected. In production every non-`local_only`
slot registration failed with `surface_slot_create_failed:422` and the React
runtime turned the rejection into a `slot_error`
(`dogfood_event_explorer`, 2026-09-24 18:36 UTC, request
`030ccf51-d74b-4d55-bf4e-2a929a4ab297`).

The write was also wrong in principle. On a same-origin integration the
signed-in user's session cookie authenticates the request, so a body the route
*did* accept would have created a draft placement in the tenant's Playbook just
from loading a gated page. Only the 422 prevented that.

`registerSurfaceSlot()` is now **client-local**: it records the slot in the
in-process registry and resolves, with no network write of any kind. A write
happens only when you configure `endpointOverrides.surfaceSlots` (or
`custom_endpoints.surfaceSlots`) to point at a slot-inventory service you run —
the same shape `persistPlacementTypes()` already uses. There is **no fallback
to `/api/placements`** under any configuration.

Nothing is lost by removing it. Surface-slot discovery is **ingestion-driven**:
the SDK already emits `slot_evaluated` / `slot_filled` / `slot_empty` /
`slot_suppressed` / `slot_error` and the `placement_*` lifecycle through
`/api/track`, carrying `surface_slot_id`, `slot_name`, `template_ids`,
`surface_type`, `category`, `decision_source` and `reason_codes`, and the
pipeline derives discovered slots from that telemetry. `SurfaceSlotSchema` is a
runtime-source (DISCOVERED) schema with `first_seen` / `last_seen` — it was
never meant to be written by a browser.

**Landed in.** `0.11.5` (BL-0197).

**Fail-closed in.** `0.11.5` — same version. The removed path had no silent
mode: before this release it threw `surface_slot_create_failed:<status>` on
every default-transport registration, so there is no window where the old
behaviour was quietly tolerated. An integration that genuinely relied on the
write must set `endpointOverrides.surfaceSlots`; one that did not was already
seeing `slot_error`.

**Proving test.** `web-sdk/surface-slot-registration-no-write.test.ts` — the
default transport performs zero writes (fetch spy, no `/api/placements` call)
and resolves even when the route replays the production 404/422; the override
path still PUTs, and falls back to POST on the override base, never on
`/api/placements`. `e2e/journey.transport.spec.ts` no longer stubs
`/api/placements` with a 200 (the stub that hid this): it records and aborts,
and `assertNoPlacementWrites()` fails the test if anything calls it.

**Ports.** No change — the Python and Rust SDKs never had a slot-registration
write.

---
## 0.11.4

### The treatment-interaction wire record now carries `rule_handle` (BL-0200)

**What changed.** `flushInteractionQueue`'s projection onto
`POST /api/events/interactions` now includes `rule_handle`, taken from the same
`ruleHandle` on `RevTurbineTreatmentInteractionInput` that 0.11.3 began stamping
on the `placement_interaction` clickstream event.

0.11.3 deliberately kept it off this record, and #530 asserted the omission with
a "never reaches the treatment-interaction wire record" test. The reasoning was
that the clickstream carries payload fields inside a JSON column — readable the
moment a producer sends them — while this record is column-shaped
(`placement_presentations`) and a new key needed a datasource migration.

The migration has since landed (revturbine-web ledger 015 added
`placement_exposure_attribution.rule_handle`), and the field is now declared on
`TreatmentInteractionInputSchema` (`revturbine-scaffold#394`, published as
`@revt-eng/*` v0.1.342). Sending it lets the app record the rule an exposure was
**decided by**, on the base exposure row, instead of waiting for the attribution
worker to reconstruct one from the clickstream when a conversion lands — which
is what makes presentation-grain analytics cuts per rule honest rather than
computed over the converted subset.

**Nothing to change in your integration.** `ruleHandle` was already public and
already populated by every `PlacementController` path; this only widens where the
value is sent. Spread, not set: the key is **absent** when no decision was in
scope. The contract accepts an explicit `null` for "a rule was selected and none
matched", but the SDK cannot distinguish that from "no decision in scope" —
`PlacementOutput.rule_id` is simply missing in both — so it asserts neither.

**No `@public` surface moved**, hence a patch release.

## 0.11.3

### `placement_interaction` now carries `rule_handle` (BL-0182)

**What changed.** #527 (BL-0062) stamped `rule_handle` at every verdict emit
site by reading `decision.output.rule_id`, but `placement_interaction` is not
a lifecycle event and does not spread `placementLifecycleBase` — its
placement keys are all optional, because a bare `trackTreatmentInteraction`
caller may supply none of them — so the click between exposure and outcome
was the one step of the funnel with no rule key. That is the step
click-through and CTR are computed over: the funnel was sliceable by rule at
both ends and not in the middle.

Five emit sites now reach the same stamped payload: `trackTreatmentInteraction`
(the projection itself), `PlacementController.trackInteraction`
(dismiss / remind_me_later / cta_clicked / cta_completed — and therefore every
React hook and `useSurfaceSlot` / `FixedSurfaceSlot` click handler built on
it), `PlacementController.fireImpression`, `trackOutputInteraction`
(output-addressed `convert()` / `dismiss()` / `snooze()`), and the
server-action `trackResult` resolver.

Spread, not set: `rule_handle` is **absent** when no decision was in scope
(a bare `trackTreatmentInteraction` call with no placement context), and
`null` on the wire means "a rule was selected and none matched" — conflating
the two would poison the slice's coverage numbers. The unknown-output branch
of `trackOutputInteraction` stamps nothing on purpose: no decision from this
SDK produced that output, so there is no rule to name.

Companion to `revturbine-scaffold#391`, which added `rule_handle` to the
`placement_interaction` payload contract and `ruleHandle` to
`RevTurbineTreatmentInteractionInput` (published as `@revt-eng/*` v0.1.339,
pinned in this release).

**No wire-shape change beyond the new optional field.** `rule_handle` is
optional-and-nullable on the schema side (#391), which keeps every
already-deployed SDK out of `quarantineVerdict`. `@public` signatures are
unchanged (`web-sdk/generated/public-api.json` untouched) and
`flushInteractionQueue` still maps the treatment-interaction record field by
field, so `ruleHandle` never reaches a customer webhook.

**Python and Rust are unaffected.** Neither port emits events.

**Landed in** `0.11.3` (BL-0182, #530).

**Fail-closed in** not applicable — additive field, nothing old is rejected.

**Proving test:** `web-sdk/customer-side-canonical-interaction.test.ts`.

---

### A gate no longer paywalls forever when it loses the cold-start config race (BL-0179)

**What changed.** BL-0177 (below) split `config_unavailable` into a transient and
a terminal state for **placements** and left `checkEntitlement` on the old
behaviour. So the same cold-start race denied entitlements instead: while the
Playbook load was in flight, `checkEntitlement` — and therefore `can()`,
`gate()`, `useCan`, `useEntitlement` and `useGatedAction` — returned the
fail-closed deny with reason `config_unavailable`, which is indistinguishable
from a rule denial. A gate mounted before config resolution rendered its paywall
and never re-evaluated, hiding a feature the user had paid for.

The entitlement path now takes the same two-state split:

| state | when | behaviour |
|---|---|---|
| **transient** | a Playbook load is in flight (`getPlaybookLoadState() === 'loading'`) | `checkEntitlement` waits for it (bounded, 4s) and re-evaluates. If the load outruns that bound, `EntitlementGate` **parks** the deny instead of publishing it — `result` stays `null`, `denied` stays `false`, `isLoading` stays `true`, and **no** `gate_evaluated` is emitted — then re-checks when the load settles, at most twice per cycle. |
| **terminal** | no config provider is configured, or the load settled without a config | unchanged: fail-CLOSED deny, reason `config_unavailable` in Server mode / `entitlement_not_in_playbook` in local mode, with its `resolution_failure` diagnostic and exactly one `gate_evaluated` carrying the verdict (and its `rule_handle`). |

The emission rule is the one worth stating plainly: **exactly one
`gate_evaluated` per settled verdict, and none for the transient state** — a
lost race is not an evaluation and must not enter the gate funnel as a denial.

**No API, wire or reason-code change.** `@public` signatures are unchanged
(`web-sdk/generated/public-api.json` is untouched), both reason codes keep their
meanings, and `tests/reason-contract.json` is unchanged. A `limited`-but-allowed
result is untouched; the fail-closed contract for terminal unavailability is
untouched.

**Python and Rust are unaffected by design**, for the same reason as BL-0177:
both take the Playbook as a required constructor argument, do no I/O, and have no
not-yet-loaded window.

**Landed in.** `0.11.3` (BL-0179, #529).

**Fail-closed in.** Not applicable — terminal behaviour is unchanged; only the
transient race is now absorbed.

**Proving test.** `web-sdk/react/useCan.config-race.test.tsx` (a gate mounted
mid-race ends on the rule's verdict, allow and deny) and
`web-sdk/entitlement-config-race.test.ts` (both states, the emission rule, and
the bounded post-bound retry for `PlacementController` and `EntitlementGate`,
reached by injecting a `0` wait bound rather than with fake timers).

---

### A slot no longer paints its fallback forever when it loses the cold-start config race (BL-0177)

**What changed.** `getPlacementDecision` returns `config_unavailable` when the
Playbook has not arrived, uncached, specifically so a retry can succeed — but
nothing retried. `useSurfaceSlot` / `FixedSurfaceSlot` decide once per mount, so
on a cold `revturbine_server` load, whenever the first decision beat the two-hop
bootstrap → `/api/sdk/config` chain, the slot rendered its `fallback`
permanently and every integration had to hand-roll a retry.

`config_unavailable` now has two distinct states and the SDK handles each:

| state | when | behaviour |
|---|---|---|
| **transient** | a Playbook load is in flight | `getPlacementDecision` waits for it (bounded, 4s) and re-resolves. If the load outruns that bound, `PlacementController` re-decides when it settles — at most twice per load cycle. The slot stays in `isLoading` meanwhile and emits **no** `placement_resolved` / `slot_empty`: a lost race is not a resolution and must not enter the funnel as one. |
| **terminal** | no config provider is configured, or the load settled without a config | unchanged from before: the decision is `config_unavailable`, `visible: false`, uncached, with the resolution-failure diagnostic and the lifecycle + slot events. Bounded retries mean it settles rather than spinning. |

**No API, wire or reason-code change.** `config_unavailable` is still the reason
code, the decision shape is untouched, and `tests/reason-contract.json` is
unchanged. Customer code that already hand-rolls a retry keeps working — it is
now redundant, not wrong.

**Python and Rust are unaffected by design.** Both ports take the Playbook as a
required constructor argument and raise on a missing or malformed one
(`server-python/src/revturbine/sdk.py` `__init__`, `server-rust/src/sdk.rs`
`new`), perform no I/O, and never emit `config_unavailable` — there is no
not-yet-loaded window to retry. This is a browser/hosted-mode state only.

**Landed in.** `0.11.3` (BL-0177, #528).

**Fail-closed in.** Not applicable — the terminal behaviour is unchanged; only
the transient race is now absorbed.

**Proving test.** `web-sdk/placements/FixedSurfaceSlot.config-race.test.tsx`
(both states), plus `e2e/journey.transport.spec.ts`, whose two hand-rolled retry
loops were deleted — a retry loop reappearing there is the regression signal.

---

## 0.11.1

### The generated schema *types* gained their `Playbook*` names (BL-0165)

**What changed.** `0.11.0` renamed every option, keyword and method that carries a
Playbook. It did not rename the **generated type identifiers**, which come from
scaffold and are vendored here — so a `0.11.0` integration still had to import
`ExportedConfigSegmentsItem` to name a segment. Those types now have `Playbook*`
spellings too.

| deprecated | canonical |
|---|---|
| `ExportedConfigSegmentsItem` | `PlaybookSegmentsItem` |
| `ExportedConfigSegmentsItemPredicatesItem` | `PlaybookSegmentsItemPredicatesItem` |
| `ExportedConfigPlacementItem` | `PlaybookPlacementItem` |
| `ExportedConfigUiPathActionType` | `PlaybookUiPathActionType` |
| `ExportedConfig` | `Playbook` (already shipped in `0.11.0`) |

**This renames nothing on the wire.** The names are generated from exported keys
of scaffold's Zod barrel: both spellings resolve to the **same schema object**, so
no payload field, default or validation rule differs between them, and the OpenAPI
component names are unchanged (they come from `.meta({ id })` on the underlying
schemas, not from the key). A Playbook written by an older SDK parses byte-for-byte
identically. Scaffold's payload contract — `bundle_schema_version` /
`bundle_min_readable_schema_version` — is untouched, so there is no minimum-reader
floor to raise.

**The aliases are duplicate definitions, not type aliases.** Scaffold's generators
emit one full TS type, Pydantic model and serde struct per barrel key rather than an
alias, so in Python (`revturbine.types`) and Rust (`revturbine::types`) the old
names remain as their own complete models/structs, generated from the same schema.
No hand-written shim exists in either port, and none is wanted: it would collide
with the generated definition. In TypeScript the `core` barrel re-exports the old
pair with `@deprecated` TSDoc.

Requires `@revt-eng/schema` / `@revt-eng/core` ≥ 0.1.335, which added the
`Playbook*` keys upstream (scaffold #387).

Ruling: Kent, 2026-09-23 (BL-0156 — `ExportedConfig` naming deprecated, Playbook
canonical).

**Landed in** `0.11.1` (additive — every old name still resolves).
**Fail-closed in** `0.12.0`, when BL-0167 removes the `ExportedConfig*` keys from
scaffold's barrel and the generated definitions disappear from the vendored types
along with them. That is the same window as the `0.11.0` option/method aliases, so
an integration has one removal to absorb, not two.

**Proving test:** scaffold's `src/core/zod/playbook-generated-names.test.ts` (each
`Playbook*` key is the same object as its `RevTurbineConfig*` and `ExportedConfig*`
counterparts; a legacy `export-config.json` payload parses to an equal result
through both spellings of the config schema), plus this repo's
`scripts/check-vendored-types.mjs` (the vendored py/rs copies agree with the pin).

**Public-API snapshot: unchanged.** `pnpm check:public-api` still reports the same
**62** `@public` exports and `web-sdk/generated/public-api.json` is byte-identical,
because the `core` barrel's type re-exports carry no `@public` tag. Recorded here
rather than left implicit: a rename touching the SDK's type vocabulary that moves
*no* snapshot entry is worth stating, so a reader does not go looking for the diff.
No existing export's signature changed and none was removed.

## 0.11.0

### `Playbook` is the canonical name for every option that carries one (BL-0156)

**What changed.** `ExportedConfig` is dead vocabulary. Plan 118 renamed the
domain object to **Playbook** and plan 104 renamed the schema type to
`RevTurbineConfig`, but the *option*, *keyword* and *method* names that carry a
Playbook around the SDK still spelled it `exportedConfig` / `exported_config`.
Every one of them now has a `Playbook`-named counterpart; every old name stays
as a deprecated alias that still works.

TypeScript:

| deprecated | canonical |
|---|---|
| `localRuntime.exportedConfig` | `localRuntime.playbook` (already shipped; see below) |
| `localRuntime.resolvers.resolveExportedConfig` | `localRuntime.resolvers.resolvePlaybook` |
| `configProvider.getExportedConfig()` | `configProvider.getPlaybook()` |
| `sdk.getExportedConfig()` | `sdk.getPlaybook()` |
| `getPolicy().exportedConfigVersion` | `getPolicy().playbookVersion` |
| `BrowserRuntimeOptions.exportedConfig` | `BrowserRuntimeOptions.playbook` |
| `LocalEvaluationServerOptions.exportedConfig` | `LocalEvaluationServerOptions.playbook` |
| `ExportedConfigProvider` (type) | `RevTurbineConfigProvider`, also exported as `PlaybookProvider` |
| `ExportedConfig` (type) | `Playbook` |

Python: `RevTurbineCustomerSdk(exported_config=…)`, `LocalRuntime(exported_config=…)`,
`LocalRuntime.get_exported_config()`, `create_static_placement_resolver(exported_config=…)`,
`derive_local_entitlement_from_configured_rules(exported_config=…)`,
`configured_plan_name_from_exported_config`, `parse_exported_config_or_throw` and
`static.ExportedConfig` all gained `playbook`-spelled counterparts.

Rust: `configured_plan_name_from_exported_config` is now
`configured_plan_name_from_playbook`, with the old name kept as the crate's
first `#[deprecated]` item. Rust has no keyword arguments, so nothing else in
that port was a caller-visible name.

`RevTurbineConfigProvider`'s two accessors are both OPTIONAL on the interface so
that an existing `implements RevTurbineConfigProvider` clause keeps compiling;
the `configProvider` option intersects it with a union that still requires
exactly one of them, so a provider implementing neither is a compile error where
it is passed.

Reading a deprecated name logs **one** development-build warning per runtime
(one `DeprecationWarning` per process on Python) naming the canonical
replacement — one flag for every alias, so an integration still spelling several
of them gets a single line, not a wall. Production builds are silent. Requires
`@revt-eng/core` ≥ 0.1.331, which made the same rename upstream (scaffold #380).

Ruling: Kent, 2026-09-23 (BL-0156).

**Landed in** `0.11.0`. **Fail-closed in** `0.12.0` for the `ExportedConfig`
aliases — until then every old name works and warns once.

**Proving test:** `web-sdk/playbook-option.test.ts` (canonical never warns, the
alias still resolves, one warning across three read sites, both spellings reach
the same Playbook at every public read site),
`server-python/tests/test_playbook_option.py` (the same contract plus
`get_exported_config()`), and `server-rust/src/user_context.rs`
`playbook_rename_tests` (the alias returns exactly what the canonical returns).

### `localRuntime.playbook` is the canonical local-mode config key

**What changed.** The record this file owed and never carried: `localRuntime.playbook`
shipped earlier as the canonical spelling of `localRuntime.exportedConfig`, with
`resolveLocalPlaybook()` as the single resolver deciding precedence, but no
changelog entry was ever written for it — so an integration could not date the
change. It is recorded here rather than back-dated, because the version it
landed in is not the version this entry appears in and pretending otherwise is
exactly the confusion the "Landed in" / "Fail-closed in" split exists to
prevent. As of `0.11.0` the alias also warns once (it did not before).

**Landed in** a release before `0.11.0` (additive; the alias never stopped
working). **Fail-closed in** `0.12.0`, with the rest of the `ExportedConfig`
aliases.

**Proving test:** `web-sdk/playbook-option.test.ts` — `resolveLocalPlaybook`
accepts either key, prefers `playbook`, and warns only for the alias.

### `publicKey` is the only browser credential; `ingestPublicKey` is gone (BL-0113)

**What changed.** `0.10.0` made `publicKey` the browser credential and kept
`apiKey` and `ingestPublicKey` working as aliases "for one minor". This is that
minor:

- **`ingestPublicKey` is removed from `RevTurbineInitOptions`.** Passing it is
  now a **type error**, including when the options are built in a variable
  (`ExactInitOptions` rejects it there too).
- **`apiKey` is no longer read as a browser credential.** It still exists, and
  still means exactly one thing: the secret **server key**, for
  `@revturbine/sdk/server` and for the headless SDK on a backend. A browser init
  that supplies only `apiKey` now resolves **no** browser credential and fails
  at init, instead of silently sending a server key as the bearer.

`resolveBrowserPublicKey()` reads `publicKey` and nothing else, and
`resetBrowserKeyAliasWarning()` is gone with the warning it reset. Keyless
local-only init is unchanged, and the plan 95 anonymous `sdk_init` beacon now
keys off `publicKey` alone.

Ruling: Kent, 2026-09-23 (BL-0113), closing the window plan 257 opened.

**Landed in** `0.11.0`. **Fail-closed in** `0.11.0` — the same release. This IS
the fail-closed half of the `0.10.0` entry below; there is no further tolerance
window.

**Proving test:** `web-sdk/public-key-option.test.ts` (`publicKey` is the bearer
on ingest and every control-plane fetch; `apiKey` resolves nothing; nothing
warns), `web-sdk/customer-side-ingest.test.ts` (the bearer no longer carries the
server key), and `web-sdk/init-options-exactness.test-d.ts` (`ingestPublicKey`
is a type error inline AND in a variable — if the key is ever re-added, `tsc`
fails on the unused `@ts-expect-error`).

---

## 0.10.10

### Trial tokens now reach placement content, not only `getPersonalizationTokens()` (BL-0169)

**What changed.** A placement whose copy authors `{{trial_days_remaining}}` or
`{{trial_days_total}}` now renders the live values. Content interpolation sources
its token map from the **output content itself**, so a provider-derived token
only reaches the copy if the resolver writes it onto that content first. The
usage lane always did (`usage_current`, `usage_limit`, `usage_percent`,
`usage_remaining`, `reset_date`); the trial lane never did, so a `trial_ending`
body reading `"{{trial_days_remaining}} days left"` shipped the literal
`{{trial_days_remaining}}` to the end user — on every port. The two names were
derived for `getPersonalizationTokens()` all along, which is why the gap survived:
a host that read the token map saw the right numbers and a host that authored the
token into copy did not.

| | before | now |
|---|---|---|
| `getPersonalizationTokens().trial_days_remaining` | live value | live value (unchanged) |
| content `{{trial_days_remaining}}` / `{{trial_days_total}}` | literal `{{…}}` | live value |
| `outputContent.trial_days_remaining` / `_total` | absent | written when the plan provider carries a finite number |

Identical on all three ports (`ts:local-resolver.ts`,
`py:core/placements/local_resolver.py`, `rs:placements/static_resolver.rs`): the
same two token names, a `Number.isFinite` guard, provider state winning over an
authored content value of the same key, and the value passed through **without
widening** — `day_number` 7 + `days_remaining` 3 is `trial_days_total` `10`, never
`10.0` (BL-0155).

**Who this reaches.** Any host whose placement copy authors either token. Copy
that hard-coded one of those keys as a decorative literal now has it overwritten
by live state — the same precedence the usage lane and
`derivePlacementPersonalizationTokens` have always had. `{{trial_plan_name}}` and
`{{trial_features_used}}` remain **not yet wired** by the placement-studio-ui
spec's own note and are untouched.

**Landed in.** `0.10.10`.

**Fail-closed in.** `0.10.10` — absence still leaves the raw token standing
rather than rendering `0`, so a host with no trial provider state sees exactly
what it saw before.

**Proving test.** Parity scenario `trial_tokens_in_content` under
`"normalize": "preserve-representation"` (byte-locked ts ≡ py ≡ rs), plus
`py:tests/placements/test_local_resolver.py` and `rs:tests/static_resolver.rs`
`trial_tokens_are_injected_from_plan_provider_state` and its two neighbours,
mirroring the scaffold-side `local-resolver.test.ts` cases. Needs
`@revt-eng/core` 0.1.331 or later (scaffold #382) for the TS half; this release
pins 0.1.332.

---

## 0.10.9

### The trial-status overlay no longer changes a number's type (BL-0155)

**What changed.** The `UserTrialStatus` → `trial_*` PlanProviderState overlay now
passes each numeric field through on every port, instead of two ports widening
it to a float. The canonical behaviour is the TS SDK's
`synthesizeProviderContext` (`web-sdk/customer-side.ts`, the `planTrialFields`
block), which spreads every `UserTrialStatus` member verbatim: an integer
`progress_percent` stays an integer on the provider state, and
`trial_days_total` is `day_number + days_remaining` in the inputs' own kind, so
`7 + 3` is `14`. The two server ports diverged from it:

| field | Python before | Rust before | all three now |
|---|---|---|---|
| `progress_percent` → `trial_progress_percent` | `float(v)` | verbatim | verbatim |
| `days_remaining` → `trial_days_remaining` | `float(v)` | verbatim | verbatim |
| `usage_consumed` → `trial_usage_consumed` | `float(v)` | verbatim | verbatim |
| `usage_limit` → `trial_usage_limit` | `float(v)` | verbatim | verbatim |
| `in_trial` → `trial_active` | `bool(v)` | verbatim | verbatim |
| derived `trial_days_total` | `float(a) + float(b)` | `f64` sum | `int + int` → `int`; any fractional half → float |

**Who this reaches.** Only a host that reads the provider state it built —
`revturbine::overlay_trial_status_on_plan_provider` on Rust, or the merged
`PlanProviderState` on Python — and cares whether it holds `70` or `70.0`
(serializing it, comparing it to an integer, or logging it). No decision
changes: every reader in the trial-gating layer widens on read, which is exactly
why the divergence survived. A non-numeric `day_number`/`days_remaining` half
now derives no total on Python instead of raising, matching Rust's existing
numeric guard.

**Landed in.** `0.10.9`.

**Fail-closed in.** `0.10.9` — there was no tolerated-old-shape window; the
representation simply changes.

**Proving test.**
`server-python/tests/test_trial_overlay_upsert.py::test_overlay_preserves_integer_numeric_representation`
and `server-rust/src/sdk.rs::overlay_preserves_integer_numeric_representation`
— both assert the *type*, not just the value, because `100 == 100.0` in Python.
Scenario `trial_overlay_integer_fields` locks that the three ports still decide
identically from an all-integer trial status.

> **Correction, 2026-09-23 (BL-0158, harness-only — no release).** This entry
> originally said the parity corpus *cannot* see this class of divergence,
> because `tests/parity/normalize.*` rule 4 collapses integral floats by design
> and nothing in the corpus returned the overlaid provider state. Both halves
> are now closed and the sentence no longer holds:
> `trial_overlay_integer_fields` drives `resolveProviders` (already shipped on
> all three runtimes) under a new per-scenario
> `"normalize": "preserve-representation"` flag that turns the collapse off, so
> `14` and `14.0` are different bytes and the cross-language byte-diff fails on
> a widened field. No public API changed; the harness gained the ability to see
> provider state.

---

## 0.10.8

### `{{recommended_plan_name}}` and `{{plan_name}}` no longer reach end users as raw tokens (BL-0121)

**What changed.** The placement-decision lane now substitutes the five tokens
the SDK resolves from the Playbook — `plan_name`, `plan_price`,
`upgrade_plan_price`, `recommended_plan_handle`, `recommended_plan_name` —
into `RevTurbinePlacementDecision.content` (and the mirrored
`decision.output.content`). It previously substituted `plan_price` and
`upgrade_plan_price` only.

`recommended_plan_handle` / `recommended_plan_name` were already derived, by
the parity-locked `resolveRecommendedPlanTokens` dispatch, and already readable
via `getPersonalizationTokens()`. Nothing wrote them into rendered content, so
a placement authored with `"Upgrade to {{recommended_plan_name}}"` shipped the
literal braces to the end user. Observed on the CybeDefend demo, 2026-09-22.

Two properties of the substitution are deliberate:

| input | result |
|---|---|
| a token the SDK owns but cannot resolve (top-of-ladder user has no next plan) | empty string — the spec's documented empty-token convention |
| a token the SDK does not own (`{{usage_percent}}`, an app-defined token) | left verbatim, so the React render lane still resolves it |

`plan_name` resolves through the plan's `unique_handle`, the matching identity
— the lookup used to be handed the plan *object*, which by design resolves
nothing, so `{{plan_name}}` rendered raw for every user identified by
`plan_handle`.

**Landed in.** `0.10.8`.

**Not fixed here.** `{{upgrade_plan_price}}` still renders the ANNUAL amount
for a plan that has both an annual and a monthly variation. Variation
preference keys off the user's billing cadence, but no supported input carries
it (`billing_period` is absent from `UserContextSchema` and from the recognized
`identify()` / `update()` keys), so selection falls through to the
alphabetically-first variation and `<plan>_annual` always wins. Closing it
needs a schema field for the cadence and a contract for which period the token
reflects when the cadence is unknown; both are open on BL-0121.

**Proving test.** `web-sdk/customer-side-upgrade-tokens.test.ts`.

---

## 0.10.7

### The Python and Rust ports stop filtering payloads on `status` (BL-0151)

**What changed.** Payload `status` is no longer a runtime predicate in any port.
Python and Rust required `status == "active"` on a placement payload before it
could become a candidate, and read a `status` off each content-linked studio
payload before overlaying its copy. Both now ignore it, matching the TypeScript
port, which never gated on it.

| | Before | After |
|---|---|---|
| Placement payload candidacy (Python, Rust) | required `status == "active"` | every payload, status ignored |
| Content-linked copy overlay (Python, Rust) | required the studio payload's `status` to read `active` | always overlaid |
| TypeScript | already ignored `status` | unchanged |

**Why it mattered.** `status` is not a field of the exported Playbook.
`RevTurbineConfigStudioPayload` and `RevTurbineConfigPlacementPayloadItem` carry
no `status` key, unknown keys are stripped on parse, and the published JSON
Schema is `additionalProperties: false` — because runtime status is *derived*
control-plane side and the stored column was dropped. So `status == "active"` was
false for **every** payload of a real Playbook: the Python and Rust resolvers
indexed no candidates at all and returned `placement_not_found`, and their
content-lookup adapters dropped every content-linked payload, keeping the inline
copy where TypeScript overlaid the linked block. A config whose first payload
carried a stray authored `status` also decided differently across ports.

The cross-language parity gate could not see any of this: the only fixtures
reaching these paths hand-write `status` on each payload — a key the schema would
strip — so the ports were compared on a shape no Playbook has.

**Landed in.** 0.10.7 (`server-python`, `server-rust`). No `@revt-eng/core`
change rides with it: TypeScript was already correct, so there is no scaffold
release and no pin bump.

**Fail-closed in.** n/a — this release removes a fail-*closed* filter. Python and
Rust consumers on a real Playbook go from no decision to the decision
TypeScript has always returned.

**Proving test.** `tests/parity/fixtures/payload_status_filter.json` — two lanes:
a stray authored `status` that disagrees with drag order (payload 1 `draft`,
payload 2 `active`; payload 1 must still win), and the real wire shape with no
`status` anywhere plus a content-linked overlay. Mutation-checked by reinstating
the Python filter, which diverges on the first call. Plus
`server-python/tests/placements/test_local_resolver.py`,
`test_json_content_provider.py` and `server-rust/tests/static_resolver.rs`, each
covering both the stray-value and the no-key case.

**Who is affected.** Every `revturbine` (PyPI) and `revturbine` (crates.io)
consumer resolving placements from a schema-valid exported Playbook — that is,
one produced by the control plane rather than hand-written with a `status` field.
Those integrations were receiving no placement decisions at all.

---

## 0.10.6

### The trial-status PlanProvider overlay ships in the Rust crate (BL-0153)

**What changed.** `revturbine::overlay_trial_status_on_plan_provider` is a new
public function on the Rust crate: it maps a runtime `UserTrialStatus` onto the
`trial_*` fields of a resolved PlanProviderState, the fields the placement
resolver's `trial_progress` / `trial_ending` / `trial_ended` /
`trial_converted` gates and milestone supersession read. Python has always done
this inside its shipped package
(`revturbine.sdk._overlay_trial_status_on_plan_provider`); on Rust the mapping
existed only as a private helper the facade used, so a host that assembles its
own provider context — including this repo's own parity runner — had to
re-implement it. Additive: no existing signature changed.

Porting Python's mapping faithfully corrected two Rust-only divergences in the
overlay the facade applies:

| `UserTrialStatus` field | Rust before | Rust now (= TS/Python) |
|---|---|---|
| `day_number` + `days_remaining` | not derived | `trial_days_total = day_number + days_remaining`, only when both are present |
| `day_number` | written to `trial_day_number` | not written — no provider-state field reads it |
| `usage_entitlement_handle` | dropped | `trial_usage_entitlement_handle` |

`trial_days_total` is the input to the time-mode progress fallback in
`placements::trial_gating`, so before this the fallback could never fire on the
Rust port.

**Landed in.** `0.10.6`.

**Fail-closed in.** `0.10.6` — the parity facade-presence gate
(`tests/parity/facade-surface.json`) no longer allow-lists a runner-local
overlay, so a future re-implementation harness-side fails the gate.

**Proving test.** `server-rust/src/sdk.rs` `overlay_maps_every_canonical_trial_field`,
`trial_days_total_requires_both_halves`, `overlay_does_not_clobber_base_state_with_null`
(mirroring `server-python/tests/test_trial_overlay_upsert.py`), plus the
`trial_ending_days_before_end`, `trial_ended_post_expiry` and
`trial_progress_milestone_supersession` parity fixtures.

---

## 0.10.5

### Trial-only local integrations get provider context (BL-0120)

**What changed.** `synthesizeProviderContext()` — the fallback that builds
`DomainProvider` state from `userContext` when no explicit domain provider is
registered — dropped an integration's trial data whenever no commercial
`plan` / `plan_handle` was also present. An app supplying **only**
`initialData.trialStatus` (or `setTrialInstances()` / `setTrialStatus()` with
no plan) got no provider context at all: `providers.plan` came back
`undefined`, so `{{trial_days_remaining}}` (and every other `trial*` token
`derivePlacementPersonalizationTokens` derives from `providers.plan`) stayed
raw, unresolved, in placement copy. Reported against the CybeDefend demo
(SDK 0.7.13): a `trial_ending` placement with `in_trial: true,
days_remaining: 3` left `{{trial_days_remaining}}` literal in the rendered
body.

Two omissions, same root cause — trial was never checked alongside
`plan` / `plan_handle` / `usage` / `tiers` / `experiments`:

- the early-return guard (`if (!plan && !planHandle && !usage && !hasTiers
  && !hasExperiments) return undefined;`) treated a trial-only integration as
  having no signal whatsoever;
- even past that guard, the returned `plan` key itself was gated on
  `plan || planHandle` — so the trial fields (`trialActive`,
  `trialDaysRemaining`, etc.) it computed were still discarded for a
  plan-less trial.

Both gates now also check `hasTrial` (an explicit trial signal — the default
untouched `{ in_trial: false }` sentinel does not count, so the omitted-signal
short-circuit is otherwise unchanged for integrations that supply nothing at
all). `usage`-only, `tiers`-only, and `experiments`-only integrations already
threaded through correctly before this change; trial was the only signal
missing from both checks.

No public API change — `synthesizeProviderContext` is private, and the fix is
additive: a plan-less trial integration now gets a `providers.plan` it never
got before, with an empty `currentPlanHandle: ''` (no plan name/handle was
ever supplied to derive one from).

**Landed in** `0.10.5`. **Fail-closed in** n/a — a previously-dropped signal
is now included; nothing that resolved before stops resolving.

**Proving test:** `web-sdk/customer-side-trial-token-signal.test.ts` — a
trial-only local integration now gets a non-empty provider context with
`trialActive`/`trialDaysRemaining` set, and feeding those through
`derivePlacementPersonalizationTokens` + `resolveContent` renders
`{{trial_days_remaining}}` as `"3"` instead of leaving it literal. Includes
the positive control (trial + plan together — unchanged), the negative
control (no trial data at all — the token stays absent, never coerced to
`"0"`), and a sibling check confirming usage-only integrations were already
unaffected by the guard.

---

## 0.10.4

### Every payload is a selection candidate, not just the first (BL-0122)

**What changed.** A placement's payloads are now *all* candidates on both
selection paths, in all three ports. Previously each port considered exactly one
payload per placement — TypeScript took `payloads[0]`, Python and Rust the first
payload with `status == "active"` — so payloads 2+ were never candidates and
their `target.segment_chips` could not be evaluated at all.

| | Before | After |
|---|---|---|
| Candidacy | one payload per placement | every payload (Python/Rust: every `active` payload) |
| `target.segment_chips` on payloads 2+ | never evaluated | evaluated per payload |
| Drag precedence | a pre-filter — it chose the only candidate | a tiebreaker among the payloads the user **matches** |
| Direct lookup by name/id | mapped a name to one payload | maps a name to every payload, gated individually, first eligible wins |

The contract this restores is
[`placement-prioritization.md`](https://github.com/revt-eng/revturbine-devkit/blob/main/docs/specs/scaffold/placement-prioritization.md)
§1 stage 3 — "Targeting — the user's plan and segment match **a payload**" — with
§4 and Appendix D scoping drag precedence to payloads that are equally eligible.

**Why it mattered.** A placement holding an admin payload and a member payload
gave every member either the admin copy (when payload 1 was unchipped) or
nothing at all (when payload 1 was chipped to admins). An integration hit the
second shape on 0.7.13 and concluded config-driven segmentation was inert. Plan
233 TASK-7 had already made the chip predicate real — but the predicate was only
ever asked about one payload.

**Landed in.** 0.10.4 (all three ports, plus `@revt-eng/core` 0.1.326).

**Fail-closed in.** 0.10.4 — the same release. There is no tolerance window:
a user who matches no payload now receives `visible: false` with
`segment_target_mismatch` rather than payload 1's content.

**Proving test.** `tests/parity/fixtures/segment_chip_payload_selection.json`
(cross-language), plus `local-resolver-payload-selection.test.ts`,
`server-python/tests/placements/test_payload_selection.py` and
`server-rust/tests/payload_selection.rs` — each exercising **both** the slot and
the direct-lookup path, because gating one and not the other is exactly the back
door plans 138 and 233 each had to close.

**Who is affected.** Any Playbook authoring more than one payload on a
placement where payload 1 is not the payload a given user matches. Those users
now see the payload their chips select — which is the fix, and is a live
behaviour change for such configs. Single-payload placements are unaffected.

---

## 0.10.3

### The Rust port gains the decision surfaces Python already shipped (BL-0145)

**What changed.** `RevTurbineCustomerSdk` on the Rust port (`revturbine`,
crates.io) now exposes the same decision surfaces the Python port exposes.
Nothing on the TypeScript or Python side changes; this is a Rust-only,
purely additive release.

| Added | Shape |
|---|---|
| `RevTurbineCustomerSdk::can(handle, context)` | The advertised alias of `check_entitlement`, matching the scaffold SDK function surface (canonical `checkEntitlement`, alias `can`). |
| `RevTurbineCustomerSdk::get_eligible_plans()` | `Vec<EligiblePlan>` — public, segment-eligible plan variations. |
| `RevTurbineCustomerSdk::get_eligible_addons()` | `Vec<EligibleAddon>` — the add-on twin. |
| `RevTurbineCustomerSdk::evaluate_trial_status(instances, now_iso, base_plan_handle, usage_balances)` | `TrialEvaluation`, reading `free_trial_rules` / `reverse_trial_rules` from the constructed Playbook. |
| `revturbine::format_currency_minor_units(amount, currency, locale)` | Free function, because Python exposes it as a module function. |
| `revturbine::plans` | New module carrying the catalog eligibility port and the formatter. |
| `UserContext::segment_ids` | Pre-resolved segment ids the catalog methods match against. |

`UserContext` gains a field but derives `Default`, so existing construction
with `..Default::default()` keeps compiling.

**Why it was invisible.** The cross-language parity gate was green on the
catalog and currency scenarios only because the Rust parity runner
*reimplemented* `eligible_catalog` and `format_currency_minor_units` inline
rather than calling the crate — so the comparison never touched shipped code,
and the crate could lack the capability entirely without a single fixture
going red. The runner now calls `revturbine::plans`, and the inline copies are
deleted; all 102 comparisons stay byte-identical.

---

## 0.10.2

### Local mode resolves placements by slot id (BL-0119)

**What changed.** In `local_only` mode the browser SDK now resolves a placement
request against the Playbook's authored `placement_slots[]` registry.
`getPlacement({ slotId })` — with or without a `componentType` — previously
returned `null` for a slot the Playbook declared, and a controller/`usePlacement`
mount of that slot resolved to `placement_not_found`. Looking the same placement
up by **name** worked, which is what made this look like a config problem rather
than an SDK one.

Two things were missing, and both are now in place:

- **`registerSurfaceSlot()` adopts the declared template.** `surface_template_ids`
  on the registered record is what puts the shared resolver on its slot branch,
  where `trigger.slot_id` is matched. Without it the resolver fell back to direct
  lookup, which is keyed by placement **name**/id and therefore can never match a
  slot id — hence `placement_not_found`. An id passed explicitly at the call site
  still wins; the mounting code knows what it renders.
- **`getPlacement()` falls through to the slot registry.** The local placement
  cache only holds slots a decision has already run through, so a cold lookup
  found nothing and stopped. It now derives the record from `placement_slots`,
  matching on `id` and falling back to `surface_type` when only a component type
  is given — the same derivation scaffold's headless
  `LocalRuntime.slotRecordForConfig` has always performed. Registration on this
  path is local only: reading a placement never writes a surface slot back to the
  control plane.

This closes a browser-versus-headless divergence: the same Playbook decided
differently depending on which runtime read it. No public API change — no
signature moved, and nothing new is asked of the caller. A slot id that no
`placement_slots` entry declares still resolves to `null`, unchanged.

**Landed in** `0.10.2`. **Fail-closed in** n/a — a previously-`null` lookup now
returns the placement the Playbook authored.

**Proving test:** `web-sdk/local-slot-id-lookup.test.ts` — by-slot-id and
by-slot-id-plus-component-type both resolve, the controller path no longer
reports `placement_not_found`, an undeclared slot id still returns `null` and
gains no invented template, an explicit `surfaceTemplateIds` still wins, and the
by-name lookup that always worked keeps working (the positive control).

---

## 0.10.1

### Treatment interactions carry the identified `account_id`

**What changed.** Every treatment interaction the SDK sends to
`/api/events/interactions` — the impression that writes a
`placement_presentations` row, plus dismiss / click / conversion — now carries
`account_id`, taken from the account the integration identified
(`identify(userId, { account_id })` / `setUserContext`). It was never sent at
all, so the ingest route's `account_id ?? user_id` fallback stamped a **user**
id into an **account** column. `placement_presentations.account_id` is a join
key, not a label: `monetization_funnel` matches it against account ids from
`events_clickstream` / `events_billing`, and every experiment summary pipe
reads it when `analysis_unit='account'`. Those joins therefore matched only
where a user id happened to equal an account id — and an account-grain
experiment readout returned the user-grain n while looking perfectly valid.

Two details make it a usable key. The value is PII-redacted **identically to
`/api/track`**, so an email-shaped account id becomes the same hash in
`placement_presentations` and in `events_clickstream` and the funnel actually
joins. And when no account was identified the field is **omitted**, never set
to the user id — the route keeps its own fallback for SDKs that have not
upgraded, but a wrong join key is worse than a missing one.

No public API change: nothing new is asked of the caller, and
`RevTurbineTreatmentInteractionInput` is unchanged. Integrations that already
pass `account_id` to `identify()` get correct account-grain analytics with no
code change; integrations that never identify an account are unaffected on the
wire and see the same route-side fallback as before.

**Landed in** `0.10.1`. **Fail-closed in** n/a — additive; nothing old is
rejected.

**Proving test:** `web-sdk/interaction-wire-contract.test.ts` — "the account
identity the analytics joins key on": the identified account reaches the wire
distinct from `user_id`, an unidentified one is omitted rather than copied from
`user_id`, an email-shaped account id matches the `/api/track` lane
byte-for-byte, and a re-queued batch keeps the account that was acting when
each interaction happened.

---

## 0.10.0

### `publicKey` is the browser credential; `apiKey` is the server key

**What changed.** The browser init option for the ingest (public) key is
`publicKey` — on `initRevTurbine`, `<RevTurbineProvider options>`, and the
headless init alike. Every browser bearer (ingest, launched-Playbook delivery,
user context, branding, trial status) uses that one key. `apiKey` now means
one thing everywhere: the secret **server key**, as it always did on
`@revturbine/sdk/server` — pass it from backend code only (a route handler
using `@revturbine/sdk/headless` keeps using `apiKey`). The name states what the
credential is at the call site: a security scanner or an agent that meets
`publicKey` in a bundle knows it belongs there, where `apiKey` reads as a leak.

`apiKey` and `ingestPublicKey` are still accepted on a browser init as aliases
of `publicKey` for one minor (precedence: `publicKey`, then `ingestPublicKey`,
then `apiKey`). Using an alias without `publicKey` in a browser logs a one-time
development warning naming `publicKey`; production builds are silent. On the
browser `RevTurbineInitOptions` type, `apiKey` is now optional (it was required)
and `ingestPublicKey` is `@deprecated`. Keyless local-only init is unchanged,
and the plan 95 anonymous `sdk_init` beacon still fires only when no public key
(`publicKey` or `ingestPublicKey`) was supplied.

Ruling: Kent, 2026-09-21, devkit PR #808 (closed).

**Landed in** `0.10.0`. **Fail-closed in** `0.11.0` — `ingestPublicKey` was
removed from the options type and `apiKey` stopped being read as a browser
credential (BL-0113); see the `0.11.0` entry above.

**Proving test:** `web-sdk/public-key-option.test.ts` — precedence, the single
bearer across ingest and control-plane fetches, the browser-only warning, and
the keyless local-only init. Type-level: `web-sdk/init-options-exactness.test-d.ts`
accepts `publicKey` and rejects the `publickey` casing typo.

### `endpoint` and `mode` are optional on `initRevTurbine` and `<RevTurbineProvider>`

**What changed.** `RevTurbineInitOptions.endpoint` defaults to
`https://revturbine.com/app` (`DEFAULT_HOSTED_ENDPOINT`, exported) and
`RevTurbineInitOptions.mode` defaults to `'snippet'` (`DEFAULT_SDK_MODE`,
exported); `<RevTurbineProvider>` passes `'react'` when the app does not set it.
Both were required; `mode` only ever labelled telemetry (`page_view.mode` and a
diagnostics message), and every hosted integration used the same endpoint.
Existing calls that pass them are unchanged. Local mode is unchanged (its
placeholder defaults already applied). Additive, no version bump required.

**Landed in** `0.10.0`. **Fail-closed in** n/a — nothing old is rejected.

**Proving test:** `web-sdk/public-init.test.ts` — "defaults endpoint and mode
for a hosted init that omits them".

### Reason-code compatibility verification

Added a reviewed baseline for 27 entitlement and 21 placement reason values,
checked against live SDK/core fixtures. Removal/rename controls exercise every
protected value, and baseline changes require this changelog to change through
the existing public-API gate. Custom provider reasons remain extensible and
free-form diagnostics are excluded. This adds verification only; no runtime
reason values or package versions change.

Proving tests: `web-sdk/reason-contract.test.ts` and
`web-sdk/reason-contract-policy.test.ts`. The intentional-change procedure is
in `docs/reason-code-contract.md`.

## 0.9.3

### Fixed

- Placement explanations use the same published segment-eligibility helper as
  decisions, keeping OR-within-segments and AND-with-plan behavior aligned.
  The explanation/decision matrix covers local and provider-backed Playbooks,
  unknown or missing segments, exact handle matching and plan-filter combinations.

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
