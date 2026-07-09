---
title: Integration Points
description: How the customer's app interacts with the RevTurbine SDK — methods, patterns, and contracts.
sidebar:
  order: 2
---

## Design Principle: Additive Only

RevTurbine is **additive** — it enhances the customer's app but is never required for baseline UX. The customer's app must look and function correctly without a placement payload. Surface slots return "nothing to show" by default; the app renders its standard UI. Placements layer conversion, expansion, and retention experiences on top.

RevTurbine is the **authoritative source** for access decisions on gated and usage-limited features. The customer's app delegates entitlement checks to RT and enforces the result — no hard-coded access logic. Plan changes, entitlement updates, and placement configurations take effect immediately without code deploys.

## Key SDK Methods

| Method | Purpose | Outputs |
|---|---|---|
| `initRevTurbine(config)` | Initialize the SDK. Call once on startup. | — |
| `rt.identify(userId, context)` | Identify user with plan, usage, and traits. | — |
| `rt.getPlacement(config)` | Get the winning placement for a slot or entitlement. | `PlacementOutput \| null` |
| `rt.can(handle, context?)` | Pure access check — feature, usage, credits, seats, tiers. | `{ status, currentTier?, reason? }` |
| `rt.update(balances)` | Update cached balances between `identify` calls. | — |
| `rt.getTrialStatus()` | Get current trial state. | `{ inTrial, trialType, planHandle, dayNumber, daysRemaining }` |
| `rt.dismiss(outputId)` | User dismissed a placement. | — |
| `rt.snooze(outputId)` | User snoozed a placement ("remind me later"). | — |
| `rt.convert(outputId)` | User completed CTA. | — |
| `rt.track(name, data?)` | Behavioral event for propensity scoring. | — |

## Two Integration Patterns

### 1. Slot-Based (Fixed, Passive)

```javascript
const p = rt.getPlacement({
  slotId: "header_upgrade_cta",
  surfaceType: "button"
});
if (p) renderUpgradeButton(p.content.label, p.cta_path);
else renderDefaultButton(); // additive only
```

### 2. Entitlement-Based (Gated, Usage/Credit/Seat)

```javascript
const access = await rt.can("ai_export");
if (access.status === "denied") {
  const p = rt.getPlacement({ entitlementHandle: "ai_export" });
  if (p) showModal(p);
  else showGenericDenial();
} else {
  startExport();
}
```

## `can` Context by Type

| Entitlement Type | Context Parameter | What the App Passes | Response Includes |
|---|---|---|---|
| Feature | — | Nothing. Binary access. | `status` |
| Capability Tier | `{ requiredTier }` | The tier level needed | `status`, `currentTier` |
| Usage Limit | `{ used }` | Current consumed amount | `status` |
| Credits | `{ balance }` | Remaining credit balance | `status` |
| Seat | — | Nothing. RT knows from Stripe. | `status` |

**Principle:** The app passes only what it knows better than RT (current consumption, which tier is needed). RT handles everything it can derive from plan configuration and Stripe state.

## Usage Limit Example

```javascript
const used = billing.getUsed("ai_credits");
const access = await rt.can("ai_credits", { used });

if (access.status === "allowed") {
  executeAction();
  billing.recordUsage("ai_credits", 1);
  rt.update({ ai_credits: billing.getUsed("ai_credits") });
} else if (access.status === "limited") {
  executeAction(); // still allowed — approaching limit
  billing.recordUsage("ai_credits", 1);
  rt.update({ ai_credits: billing.getUsed("ai_credits") });
  const p = rt.getPlacement({
    slotId: "usage_warning",
    surfaceType: "banner",
    entitlementHandle: "ai_credits"
  });
  if (p) renderBanner(p);
} else {
  const p = rt.getPlacement({
    slotId: "usage_limit_gate",
    surfaceType: "modal",
    entitlementHandle: "ai_credits"
  });
  if (p) showModal(p);
  else showGenericDenial();
}
```

## Handling `cta_path`

Every placement payload includes a `cta_path` object. The `type` field determines the action:

| `cta_path.type` | App handles by… |
|---|---|
| `open_checkout` | Opening Stripe Checkout for the specified plan |
| `view_plans` | Navigating to plans page (or chained placement) |
| `book_demo` | Opening booking tool |
| `contact_sales` | Opening sales contact form |
| `complete_onboarding` | Navigating to onboarding task |
| `invite_teammate` | Opening invite flow |
| `open_rt_placement` | Evaluating a chained placement via `placementHandle` |
| `custom` | App-defined action via `handle` |
| `dismiss` | Closing the placement |
| `snooze` | Closing and re-queuing for later |

```javascript
function handleCTA(placement) {
  const { cta_path } = placement;
  switch (cta_path.type) {
    case "open_checkout":
      return openCheckout(cta_path.plan_handle, cta_path.promotion_id);
    case "view_plans":
      if (cta_path.placement_handle) {
        const p = rt.getPlacement({
          placementHandle: cta_path.placement_handle
        });
        return p ? renderPlacement(p) : navigateToPlans();
      }
      return navigateToPlans(cta_path.plan_handle);
    case "open_rt_placement":
      const next = rt.getPlacement({
        placementHandle: cta_path.placement_handle
      });
      return next ? renderPlacement(next) : navigateToPlans();
    case "book_demo":
      return openBooking();
    case "contact_sales":
      return openSalesContact();
  }
}
```

## Placement Payload Example

```json
{
  "output_id": "gated_ai_export__free_users",
  "category": "gated_feature",
  "surface": {
    "template": "modal_overlay_optional",
    "type": "modal",
    "slot_id": "feature_gate_modal",
    "entitlement_handle": "ai_export"
  },
  "content": {
    "header": "Unlock AI Export",
    "body": "Upgrade to Pro for AI enhancements.",
    "cta_label": "Upgrade to Pro"
  },
  "promotion": { "id": "promo_20_off_annual", "discount": "20%" },
  "cta_path": {
    "type": "open_checkout",
    "plan_handle": "pro",
    "promotion_id": "promo_20_off_annual"
  },
  "decision_id": "dec_abc123",
  "config_version": "v42",
  "present_upsell": true
}
```

**Standard output fields:** `config_version` (string) lets the app detect stale config. `decision_id` (string) is a unique ID for debugging and analytics. `present_upsell` (boolean) indicates whether the placement includes an upgrade or expansion offer.

## Modal Safety Rule

Modal (`surfaceType: "modal"`) is interruptive — it takes over the screen. Only request a modal at **safe moments**: when the user has just performed an action, completed a task, or reached a natural transition. Never on passive page render.

Non-interruptive types (`banner`, `in_page`, `button`, `toast`) are safe on render.
