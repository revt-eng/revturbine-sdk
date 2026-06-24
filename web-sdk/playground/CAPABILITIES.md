# Prism playground — capability map & schema audit

> Plan 81 (Prism playground — capability-breadth showcase), TASK-1 deliverable.
> This is the audit that scopes TASK-5 and seeds the TASK-7 self-teaching layer.
> It answers plan 81 Q-2: *which capabilities can the published `ExportedConfig`
> contract actually express?*

The Prism playground (`web-sdk/playground/`) drives the SDK in local-runtime mode
against a bundled `ExportedConfig` (`config/prism-export-config.json`; canonical
source in `revturbine-demo-data/customers/prism/`). The demo's goal is **breadth**:
showcase as many RevTurbine capabilities as the published contract supports.

Schema references below point at `revturbine-scaffold/src/config/models/schema.ts`
(`ExportedConfigSchema` and its item schemas) and
`revturbine-scaffold/src/core/common.ts` (`EntitlementTypeSchema`).

## Demonstrated today (TASK-2 / TASK-3)

| Capability | Mechanism in config | Spec source |
|---|---|---|
| Multi-tier plans | `plans[]` — Free / Pro / Enterprise | `plans-entitlements-studio-ui.md` |
| Feature entitlement | `entitlements[].type: feature` — `batch_export`, `style_packs` | `sdk.md` §2 |
| Usage-limit entitlement | `type: usage_limit` — `generations` | `plans-entitlements-studio-ui.md` §2.3 |
| Credits entitlement | `type: credits` — `credits` (top-up available) | §2.3 |
| Rate-limit entitlement | `type: rate_limit` — `burst_rate` | §2.3 |
| Capability-tier entitlement | `type: capability_tier` — `resolution_tier` (watermark) | §2.3 |
| Enforcement modes | rule `type_fields.enforcement`: `hard_block` / `soft_block` / `allow_overage` | `placement-prioritization.md` |
| Segments / targeting | 10 `segments[]` + payload `target.segment_chips` | `targeting-studio-ui.md` §4.0 |
| Fixed placements | `category: fixed` + `surface_render` trigger — nav button, quota meter, credit counter | `placement-studio-ui.md` |
| Gated placements | `category: gated` + `entitlement_gate` trigger — hard / soft / inline gates | `sdk.md` §3 |
| Usage/credit threshold placements | `category: usage_credit_seat` + `usage_threshold` / `credit_threshold` | `overall-app-ux-structure.md` §3.4 |
| Other-conversion placements | `category: other_conversion` — new-user sidebar (segment), monthly→annual (`qualifier`) | `placement-studio-ui.md` |
| Presentation caps | payload `caps.max_per_period` + `cooldown_days` | `placement-prioritization.md` §5 |
| Surface templates | `surface_templates[]` — button, in_page, quota_meter, usage_counter, credit_balance_counter, banner, modal, toast, inline | `placement-studio-ui.md` §5.1 |

## Supported by the schema, not yet demonstrated → TASK-5 breadth targets

## Demonstrated as of TASK-5 (breadth)

Shipped — each fires from the Director and has a "why am I seeing this?" trace
(see `state/capability-trace.ts`):

| Capability | Mechanism in config | Built-in journey |
|---|---|---|
| **Free trial** | `free_trial_rules[]`; trial-ending banner (`pl_trial_ending`) | `trial_ending` |
| **Reverse trial** | `reverse_trial_rules[]`; `entitlements_during_trial` grants premium on Free with no plan change (hydrated via `localRuntime.initialData.trialStatus`; pinned by an integration test) | `reverse_trial` |
| **Retention / payment recovery** | `category: retention` placement (`pl_payment_recovery`) consuming `seg_billing_failed` | `payment_recovery` |
| **Seat / seat-limit** | `seat` entitlement (Free 1 / Pro 5 / Enterprise ∞) + `seat_threshold` placement (`pl_seat_limit`) | (seats slider) |

## Demonstrated as of plan 84 (breadth + advertised API)

| Capability | Mechanism in config / SDK | Where to see it |
|---|---|---|
| **Price-per-unit entitlement** | `price_per_unit` entitlement (`generation_overage`) + Pro/Enterprise overage rules (`amount_cents`) | studio meta shows "Overage $0.05/image" on Pro, "$0.03" on Enterprise (none on Free) — see `state/derived.ts#overagePriceFor` |
| **Plan recommendation** | payload `recommendation_strategy: next_tier_up` on `pl_usage_100` | out-of-generations modal renders "✨ We recommend Pro" — see `state/derived.ts#recommendedPlanName` |
| **Advertised hero-API** | `<RTSlot>`, `gate(action, fn)`, `track()` (SDK plan-84 aliases) | every slot renders via `<RTSlot>` (`shared/SlotHost.tsx`); ImageStudio uses `gate()` for the gated actions + `track()` on generate; `useEntitlement` is the React form of `can` |

## Deferred — NOT expressible in the published ExportedConfig (REQ-7)

These must **not** be faked with invalid config. Each is a control-plane / schema
concern owned by scaffold (Kent); raise as a dependency if the demo needs them.

| Capability | Gap | Disposition |
|---|---|---|
| **Add-on entity** (e.g. a real `credit_pack` product) | `ExportedConfigSchema` has no `add_ons` array; `credit_pack` exists only as a `content_ui_paths` CTA target string | Demo represents top-ups as a CTA path only. Real add-on entity = scaffold dependency. |
| **Customer overrides** | `CustomerOverride` exists in the control-plane API but is **not** part of the portable `ExportedConfig`; it is a per-individual server-side grant | Out of scope for a local-runtime demo. |
| **Experiments / variant assignment** | No experiment/variant entity in `ExportedConfig`; Optimization-Studio experiment workflow is largely deferred in the specs | Defer; revisit if/when the schema gains an experiment shape. |

## Drift guards

- **Schema validity (CI-authoritative):** `config/prism-export-config.test.ts`
  parses the bundled config through `ExportedConfigSchema`, the same validation
  `prism-config.ts` does at load time — now as a PR-gate test.
- **Capability breadth:** the same test asserts the demonstrated entitlement types
  and placement categories stay present, so an edit can't silently drop a capability.
- **Canonical parity:** when `revturbine-demo-data` is a sibling, the test asserts the
  bundled copy byte-matches `customers/prism/export-config.json`; run
  `pnpm sync:prism-config` to re-sync after editing the canonical. The canonical is
  independently validated by `npx tsx scripts/revturbine-cli.ts verify prism`.
- **Trace coverage:** `state/capability-trace.test.ts` asserts every config placement
  has a decision trace, so no surface can ship without a "why am I seeing this?"
  explanation.

## Teaching layer (TASK-7)

Every rendered surface carries a collapsible **"why am I seeing this?"** trace
(`stage/WhyTrace.tsx` + `state/capability-trace.ts`) naming the capability, the
condition that fired it (plan / segment / threshold / trial), and the defining
spec. Combined with the journeys (loaded + authored in the Director; see the
playground README), a viewer can connect each visible surface to the RevTurbine
capability it demonstrates without reading code.
