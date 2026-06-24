# RevTurbine — SDK Integration Points

High-level overview of how the customer's app interacts with RevTurbine's SDK. A separate SDK specification provides the full contract.

### Design Principle: Additive Only

RevTurbine is **additive** — it enhances the customer's app but is never required for baseline UX. The customer's app must look and function correctly without a placement payload. Surface slots return "nothing to show" by default; the app renders its standard UI. Placements layer conversion, expansion, and retention experiences on top. If RevTurbine is disconnected, misconfigured, or if all placements are paused, the customer's product continues to work normally.

RevTurbine is the **authoritative source** for access decisions on gated and usage-limited features. The customer's app delegates entitlement checks to RT and enforces the result — no hard-coded access logic. Plan changes, entitlement updates, and placement configurations take effect immediately without code deploys. The app always provides a sensible fallback when `getPlacement` returns `null` — a generic "upgrade required" or "limit reached" message.

## Key SDK Methods

Usage and credits both track consumption against a limit, but the app passes whichever number is natural: **Usage Limits** pass `{ used }` (accumulating toward a cap, e.g. "45 of 50 API calls"), **Credits** pass `{ balance }` (remaining from an allocation, e.g. "200 of 1,000 credits left"). RT knows the limit/allocation from Plans & Entitlements Studio and computes the percentage either way.

`surfaceType` is a strict enum: `modal`, `banner`, `in_page`, `button`, `toast`, `email`, `cli`, `full_page`, `agent`, `custom`. The SDK rejects unknown values. See Placement Studio Appendix A for the mapping from Surface Templates to Surface Types.

**Two integration patterns.** The developer wires RevTurbine into the app in two ways: **(1) Slot-based** — `rt.getPlacement({ slotId, surfaceType })` at a UI location. The PM configures Fixed and passive placements against these slots. **(2) Entitlement-based** — the developer calls `rt.checkEntitlement(handle)` for a pure access check, then `rt.getPlacement({ entitlementHandle })` or `rt.getPlacement({ slotId, surfaceType, entitlementHandle })` to fetch the placement when denied or limited. The PM configures Gated and Usage/Credit/Seat placements against the entitlement handle.

| Method | Purpose | Outputs |
| --- | --- | --- |
| `rt.init(apiKey)` | Initialize SDK. Call once on startup. API key determines environment. | — |
| `rt.identify(userId, context)` | Identify user. Context: `{ accountId, email, plan?, usage: { handle: used|balance, ... }, traits: { role, createdAt, ... } }`. Usage handles pass `used` (consumed) for Usage Limits, `balance` (remaining) for Credits. `plan` is optional — RT pulls from Stripe; pass it only to override or when Stripe sync is not configured. Location and device inferred server-side. | — |
| `rt.getPlacement(config)` | Get the winning placement. Returns at most **one** placement per call. Config object accepts: `slotId` (string), `surfaceType` (strict enum), `entitlementHandle` (string), `planHandle` (string, optional). **Slot-based** `{ slotId, surfaceType }`: used for Fixed and passive placements — RT matches against the slot. **Entitlement-based** `{ entitlementHandle }`: used for Gated and Usage/Credit/Seat placements — RT matches against the entitlement. **Both** `{ slotId, surfaceType, entitlementHandle }`: RT matches against entitlement and slot. **Plan-specific** `{ slotId, surfaceType, planHandle }`: used when the user selects a specific plan (e.g. clicks a plan card on pricing page) — RT uses the handle to return plan-specific content, CTA, and promotion. **Chained** `{ placementHandle }`: evaluates a specific placement by handle — the handle is always sourced from a prior payload's `cta_path.placement_handle`, never developer-specified (see Placement Chaining). | `{ output_id, category, present_upsell, surface, content, promotion?, cta_path, rule_id, decision_id, config_version }` or `null` |
| `rt.checkEntitlement(handle, context?)` | Pure access check. The app passes its current state; RT evaluates against its rules and returns the result. Context varies by entitlement type: **Usage Limit:** `{ used: number }` — current consumed amount. **Credits:** `{ balance: number }` — remaining balance. **Capability Tier:** `{ requiredTier: string }` — the tier level needed for this action. **Feature/Seat:** no context needed. Does not return UI — call `getPlacement` with the entitlement handle to fetch the placement when denied or limited. | `{ status, currentTier?, reason? }` where status is `"allowed"`, `"limited"`, or `"denied"`. `currentTier` included for Capability Tier entitlements. |
| `rt.updateUsage(balances)` | Update cached balances between `identify` calls. `balances: { handle: used|balance, ... }` — same convention as `identify` (used for Usage Limits, balance for Credits). Keeps passive placements current. | — |
| `rt.getTrialStatus()` | Get current trial state. | `{ inTrial, trialType, planHandle, dayNumber, daysRemaining }` |
| `rt.dismiss(outputId)` | User dismissed a placement. For analytics and cap tracking. | — |
| `rt.snooze(outputId)` | User snoozed a placement ("remind me later"). Re-queues the placement with backend-configured timing. Distinct from dismiss in analytics. | — |
| `rt.convert(outputId)` | User completed CTA. For conversion analytics and cooldowns. | — |
| `rt.trackEvent(name, data?)` | Unstructured behavioral event for propensity scoring on Other/Retention placements. | — |

**Standard output fields:** `config_version` (string) is returned by all read methods — lets the app detect stale config. `decision_id` (string) is returned by all evaluation methods (`getPlacement`, `checkEntitlement`, `getTrialStatus`) — unique ID for the decision, useful for debugging and analytics. `present_upsell` (boolean) indicates whether the placement includes an upgrade or expansion offer — `true` when a promotion or plan recommendation is attached, `false` for informational placements (e.g. a usage warning with no CTA). The app can use this to decide whether to render purchase-oriented UI elements.

### `checkEntitlement` Context by Entitlement Type

| Entitlement Type | Context Parameter        | What the App Passes                      | What RT Knows                           | Response Includes         |
| ---------------- | ------------------------ | ---------------------------------------- | --------------------------------------- | ------------------------- |
| Feature          | —                        | Nothing. Binary access.                  | User's plan → entitlement rules         | `status`                  |
| Capability Tier  | `{ requiredTier }`       | The tier level needed for this action    | User's current tier (from plan)         | `status`, `currentTier`   |
| Usage Limit      | `{ used }`               | Current consumed amount                  | The limit (from entitlement config)     | `status`                  |
| Credits          | `{ balance }`            | Remaining credit balance                 | The allocation (from entitlement config)| `status`                  |
| Seat             | —                        | Nothing. RT knows seat count from Stripe.| Seats filled, seat limit, at-limit behavior | `status`              |
| Rate Limit       | N/A                      | Not checked via SDK — enforced server-side at the API layer.  | —                  | —                         |
| Price-per-unit   | N/A                      | Not checked via SDK — billing handled by Stripe directly.     | —                  | —                         |

**Principle:** The app passes only what it knows better than RT (current consumption, which tier is needed). RT handles everything it can derive from plan configuration and Stripe state (limits, allocations, seat counts, tier assignments).

## Example Use Cases

### Slot-based (Fixed, passive)

**Fixed placement — upgrade button renders with the page:**

```javascript
const p = rt.getPlacement({ slotId: "header_upgrade_cta", surfaceType: "button" });
if (p) renderUpgradeButton(p.content.label, p.cta_path);
else renderDefaultButton(); // additive only
```

**Passive placement — banner, card, or badge on page render:**

```javascript
// Usage warning, trial prompt, promo banner, retention card —
// RT's scoring engine decides what (if anything) to show
const banner = rt.getPlacement({ slotId: "dashboard_promo", surfaceType: "banner" });
if (banner) renderBanner(banner);
```

**Plan-specific placement — user clicks a plan card on the pricing page:**

```javascript
// User clicks the "Pro Annual" plan card
const p = rt.getPlacement({
  slotId: "pricing_page",
  surfaceType: "full_page",
  planHandle: "pro_annual"
});
if (p) renderPlanDetail(p); // plan-specific CTA, promotion, messaging
else renderDefaultPlanDetail("pro_annual"); // additive only
```

### Entitlement-based (Gated, Usage/Credit/Seat)

**Gated feature — user clicks "Export with AI":**

```javascript
const access = rt.checkEntitlement("ai_export");
if (access.status === "denied") {
  const p = rt.getPlacement({ entitlementHandle: "ai_export" });
  if (p) showModal(p);
  else showGenericDenial(); // fallback — no placement configured
} else {
  startExport();
}
```

**Usage-limited feature — user triggers AI action:**

```javascript
const used = billing.getUsed("ai_credits"); // 45 — RT knows the limit (50)
const access = rt.checkEntitlement("ai_credits", { used });

if (access.status === "allowed") {
  executeAction();
  billing.recordUsage("ai_credits", 1);                    // app's billing system is source of truth
  rt.updateUsage({ ai_credits: billing.getUsed("ai_credits") }); // sync RT's cache from billing

} else if (access.status === "limited") {
  executeAction();                                          // still allowed — approaching limit
  billing.recordUsage("ai_credits", 1);
  rt.updateUsage({ ai_credits: billing.getUsed("ai_credits") });
  const p = rt.getPlacement({ slotId: "usage_warning", surfaceType: "banner", entitlementHandle: "ai_credits" });
  if (p) renderBanner(p);                                   // "5 credits remaining — upgrade for more"

} else {                                                    // denied
  const p = rt.getPlacement({ slotId: "usage_limit_gate", surfaceType: "modal", entitlementHandle: "ai_credits" });
  if (p) showModal(p);
  else showGenericDenial();
}
```

**Capability Tier — user opens advanced dashboards (requires Pro):**

```javascript
const access = rt.checkEntitlement("analytics_tier", { requiredTier: "pro" });
if (access.status === "allowed") {
  showDashboard();
} else {
  // access.currentTier = "basic" — user's actual tier
  const p = rt.getPlacement({ entitlementHandle: "analytics_tier" });
  if (p) showModal(p);           // "Upgrade to Pro to unlock advanced dashboards"
  else showGenericDenial();
}
```

## Modal Safety Rule

Modal (`surfaceType: "modal"`) is interruptive — it takes over the screen. Only request a modal at **safe moments**: when the user has just performed an action (clicked a button, hit a feature gate), completed a task (finished an export, ended a session), or reached a natural transition (completed onboarding, returned from a flow). Never on passive page render.

Non-interruptive types (`banner`, `in_page`, `button`, `toast`) are safe on render — they sit alongside existing UI without blocking the user.

## Placement Payload (Example)

Example payload for a gated feature placement returned by `rt.getPlacement({ entitlementHandle: "ai_export" })`. Actual fields vary by surface template (see Placement Studio spec, Appendix A) and category. Standard fields (`output_id`, `category`, `surface`, `cta_path`, `rule_id`, `decision_id`, `config_version`, `present_upsell`) are always present; `content` and `promotion` vary by template and CTA Path type. The `promotion` object carries display details (discount, name); the `cta_path` carries the `promotion_id` for routing to checkout.

```json
{
  "output_id": "gated_ai_export__free_users",
  "category": "gated_feature",
  "surface": { "template": "modal_overlay_optional", "type": "modal", "slot_id": "feature_gate_modal", "entitlement_handle": "ai_export" },
  "content": { "header": "Unlock AI Export", "body": "Upgrade to Pro for AI enhancements.", "cta_label": "Upgrade to Pro" },
  "promotion": { "id": "promo_20_off_annual", "discount": "20%" },
  "cta_path": { "type": "open_checkout", "plan_handle": "pro", "promotion_id": "promo_20_off_annual" },
  "rule_id": "rule_gated_ai_export",
  "decision_id": "dec_abc123",
  "config_version": "v42",
  "present_upsell": true
}
```

## Handling `cta_path` in the Response

Every placement payload includes a `cta_path` object that tells the app what to do when the user clicks the CTA. The PM configures this in the Placement Studio; the developer handles the response. The `type` field determines the action:

| `cta_path.type` | Additional fields | App handles by… |
| --- | --- | --- |
| `open_checkout` | `plan_handle`, `promotion_id?`, `billing_period?` | Opening Stripe Checkout or embedded checkout for the specified plan |
| `view_plans` | `plan_handle?`, `promotion_id?`, `placement_handle?` | Navigating to plans page, or rendering a chained placement if `placement_handle` is present |
| `book_demo` | — | Opening Calendly or similar booking tool |
| `contact_sales` | — | Opening sales contact form, chat, or scheduling tool |
| `complete_onboarding` | `event_name` | Navigating to the onboarding task. App fires `rt.trackEvent(event_name)` on completion |
| `invite_teammate` | — | Opening the invite / add-user flow |
| `refer_friend` | — | Opening the referral program flow |
| `verify_work_email` | — | Opening work email verification flow |
| `update_payment_method` | — | Opening payment method update (includes backup payment in v1) |
| `enable_auto_renewal` | — | Prompting user to turn on auto-renewal |
| `manage_subscription` | — | Opening subscription/billing management |
| `extend_trial` | — | Calling RT's trial extension endpoint (if enabled in Plans & Entitlements) |
| `open_rt_placement` | `placement_handle` | Calling `rt.getPlacement({ placementHandle })` to evaluate a chained placement. See Placement Chaining below. |
| `custom` | `handle` | App-defined action — the handle is defined centrally in Content Studio |
| `dismiss` | — | Closing the placement. Only for explicit dismiss buttons — standard close (X) is app UI, not a CTA Path. |
| `snooze` | — | Closing the placement and re-queuing for later. Timing configured in RT backend (v1). |

The developer writes a single handler that switches on `cta_path.type` — all values come from the payload, nothing is developer-specified:

```javascript
function handleCTA(placement) {
  const { cta_path } = placement;
  switch (cta_path.type) {
    case "open_checkout":
      return openCheckout(cta_path.plan_handle, cta_path.promotion_id);
    case "view_plans":
      // If a placement_handle is present, chain to that placement
      if (cta_path.placement_handle) {
        const p = rt.getPlacement({ placementHandle: cta_path.placement_handle });
        return p ? renderPlacement(p) : navigateToPlans();
      }
      return navigateToPlans(cta_path.plan_handle);
    case "open_rt_placement":
      const next = rt.getPlacement({ placementHandle: cta_path.placement_handle });
      return next ? renderPlacement(next) : navigateToPlans();
    case "complete_onboarding": return navigateToTask(cta_path.event_name);
    case "book_demo":           return openBooking();
    case "contact_sales":       return openSalesContact();
    case "invite_teammate":     return openInviteFlow();
    case "refer_friend":        return openReferralFlow();
    case "verify_work_email":   return openWorkEmailVerification();
    case "update_payment_method": return openPaymentSettings();
    case "enable_auto_renewal": return openAutoRenewalPrompt();
    case "manage_subscription": return openSubscriptionSettings();
    case "extend_trial":        return rt.extendTrial();
    case "custom":              return handleCustomPath(cta_path.handle);
    case "dismiss":             return rt.dismiss(placement.output_id);
    case "snooze":              return rt.snooze(placement.output_id);
  }
}
```

## Placement Chaining

Some placements need a two-step interaction: a lightweight trigger surface (banner, inline message, toast) whose CTA opens a richer detail surface (modal with upgrade options, plan comparison, checkout). The PM wires this in the Placement Studio by setting a primary placement's CTA Path to **"Open RT placement"** and selecting the target placement. The developer never specifies placement handles — they come from the `cta_path` in the response payload.

**How it works:**

1. **Primary placement** fires (e.g. a banner: "You've used 70% of your storage"). The payload includes `cta_path: { "type": "open_rt_placement", "placement_handle": "storage_upgrade_detail" }`.
2. When the user clicks the CTA, the app's `handleCTA` function reads `cta_path.placement_handle` from the payload and calls `rt.getPlacement({ placementHandle: cta_path.placement_handle })`.
3. **Secondary placement** evaluates and returns its Payload (e.g. a modal with plan comparison, promotion, and checkout CTA). The secondary placement has its own targeting, content, and caps — it's a first-class placement, not a sub-surface.
4. If the secondary placement returns `null` (e.g. user no longer qualifies, or caps are hit), the app falls back to a generic upgrade modal or navigates to the plans page.

**Why chaining over multi-surface Payloads:**

- **Independent targeting:** The modal can have different segment/plan targeting than the banner. An admin might see a detailed plan comparison; a member sees a simpler "ask your admin" message.
- **Independent caps:** The modal has its own presentation caps. If the user has already seen it today, the CTA can fall back to a plans page instead.
- **Reusable secondaries:** Multiple banners, inline messages, and toasts can all chain to the same detail modal. One modal placement serves as the upgrade detail for many trigger surfaces.
- **Analytics clarity:** Each placement has its own conversion funnel. You can see "banner → modal → checkout" as a chain with drop-off at each step.

## Billing & Plan State Updates

RT receives Stripe webhook events (subscription created/updated/deleted, payment succeeded/failed, invoice finalized) and updates the user's entitlement and plan state in real time. The SDK maintains a locally cached copy of the user's state, which is refreshed:

1. **On `rt.identify()`** — full state fetch on login/session start.
2. **On `rt.checkEntitlement()` / `rt.getPlacement()`** — if the cached state is stale (configurable TTL, default 60 seconds), the SDK fetches fresh state from the RT backend before evaluating. A Stripe plan change is picked up on the user's next SDK call after the TTL expires.
3. **On page reload / re-identify** — full state refresh.

Usage balances come from the app (via `rt.identify`, `rt.updateUsage`, or inline on `rt.checkEntitlement`) — not from the cache. RT doesn't meter usage; it evaluates against whatever the app reports. RT knows the **limits** from entitlement configuration; the app only needs to report **current consumption**.

For most apps, the TTL-based refresh is sufficient — a user who upgrades sees the change within seconds on their next interaction. Real-time push (WebSocket/SSE) can be added as a future enhancement.
