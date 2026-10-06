---
title: Error Codes
description: Enumerated error and reason codes returned by the SDK, with causes and fixes.
---

This page lists all error and reason codes the SDK may return, organized by category.

## Placement Reason Codes

Returned in `decision.reasonCodes[]` to explain why a placement was or wasn't shown. This is the complete set the SDK emits — generated from the public reason contract (`tests/reason-contract.json` in revturbine-sdk-internal), the same file [`reason-contract.test.ts`](https://github.com/revt-eng/revturbine-sdk-internal/blob/main/web-sdk/reason-contract.test.ts) enforces against live SDK fixtures. Do not hand-edit the table below; run `pnpm gen:reason-codes` (from `pages-build/`) after the contract changes.

<!-- BEGIN GENERATED: placement-reason-codes (scripts/gen-reason-codes.mjs) -->

| Code | Meaning |
|---|---|
| `config_unavailable` | The Playbook could not be fetched, or a fetch is still in flight — the SDK has no config to decide against yet. |
| `entitlement_gate_unmet` | The candidate's entitlement-gate trigger did not match the user's current entitlement state. |
| `no_eligible_candidate` | No candidate placement survived eligibility filtering for this slot. |
| `no_gate_for_entitlement` | The Access Gate slot asks for an entitlement that no gate placement is authored for, so the slot shows its access-denied placeholder. |
| `no_resolver_configured` | No placement resolver is configured, so the SDK has nothing to evaluate against. |
| `placement_not_found` | No candidate output matched the requested placement id or name. |
| `placement_not_registered` | The payload targets a placement handle the app never registered with the SDK. |
| `placement_retired` | The candidate's rule is hidden — for example, superseded by a conversion — per impression history. |
| `plan_target_mismatch` | The user's plan or billing period doesn't match the candidate's plan targeting. |
| `qualifier_trigger_unmet` | The candidate's qualifier trigger condition was not satisfied for the user's plan or category. |
| `sdk_disabled_provider_failure` | The SDK disabled itself after its configured providers failed, so it fails closed rather than risk showing something wrong. |
| `segment_target_mismatch` | The user doesn't belong to any of the candidate's target segments. |
| `suppressed_by_dismiss_cooldown` | The user dismissed this placement and its cooldown window has not elapsed. |
| `suppressed_by_payload_cap_day` | The payload's per-day impression cap has been reached. |
| `suppressed_by_payload_cap_lifetime` | The payload's lifetime impression cap has been reached. |
| `suppressed_by_payload_cap_month` | The payload's per-month impression cap has been reached. |
| `suppressed_by_payload_cap_session` | The payload's per-session impression cap has been reached. |
| `suppressed_by_payload_cap_week` | The payload's per-week impression cap has been reached. |
| `suppressed_by_payload_cooldown` | The payload is still inside its configured cooldown window since it was last shown. |
| `suppressed_by_presentation_cap` | Every eligible candidate is over an overall presentation cap rule from Placement Settings. |
| `suppressed_by_system_cooldown` | Every eligible candidate is a discretionary nudge inside the session cooldown since the last one shown. |
| `suppressed_until_remind_window` | The user chose "remind me later" and that reminder window has not elapsed yet. |
| `threshold_trigger_unmet` | The candidate's threshold trigger did not match the user's current entitlement usage. |
| `trial_trigger_unmet` | The candidate's trial trigger did not match the user's trial state. |

<!-- END GENERATED: placement-reason-codes -->

:::note[Client-side cap enforcement]
When `enableClientCapsEnforcement` is on, the SDK also ticks `cap.v1`
presentation-cap policies locally and can add `cap_exceeded` to
`reasonCodes` on a cache-hit re-evaluation once the local budget is
consumed. This is a client-side fallback default distinct from the
`suppressed_by_payload_cap_*` family above (which come from the evaluated
Playbook itself) and from the protected reason contract, so it is called out
here rather than generated into the table.
:::

## Entitlement Reason Codes

Returned in `result.reason` to explain the entitlement check outcome.

Entitlement checks are [**fail-closed**](/guides/entitlements/#fail-closed-semantics): when the SDK cannot produce an
affirmative grant it denies and names the cause. This is the complete emitted
set — see [Error handling](/guides/error-handling/) for the enforcement-mode
suffixes on the two limit codes.

| Code | Meaning | Fix |
|---|---|---|
| `no_matching_entitlement_rule` | No rule grants this entitlement to the user's plan — check **denied** | Add an entitlement rule targeting that plan, or check the user's `plan_handle` is the plan's `unique_handle` |
| `feature_not_enabled_for_plan` | A matching `feature` rule has `enabled: false` — check **denied** | Enable the rule for that plan, or upgrade the user |
| `usage_limit_reached` | At or over a `usage_limit` rule's limit | Report accurate usage via `updateUsage()`; raise the limit or change `enforcement` |
| `credit_balance_exhausted` | At or over a `credits` rule's allowance | Grant more credits or change `enforcement` |
| `config_unavailable` | The launched Playbook could not be fetched (Server mode) — check **denied** | Check network connectivity; the reason distinguishes a fetch failure from a real denial |
| `entitlement_not_in_playbook` | Local mode with no Playbook and no cached result — check **denied** | Add the entitlement to the Playbook fixture |
| `sdk_disabled_provider_failure` | The SDK disabled itself after a provider failure — check **denied** | Check API keys, endpoints, and network |
| `granted_by_reverse_trial` | **Allowed** by an active reverse trial rather than by the plan | None — expected during a reverse trial |

:::note[Renamed in 0.3.0]
`local_runtime_default_allow` → `entitlement_not_in_playbook`, no deprecated
alias. The old name stated a verdict the result does not have (it denies).
:::

## Provider Errors

| Error | Source | Meaning |
|---|---|---|
| `provider_chain_exhausted` | All providers failed | Check API keys, endpoints, and network |
| `config_fetch_failed` | Playbook could not be loaded | Verify `configProvider` or API endpoint |
| `invalid_api_key` | API returned 401 | Check the `publicKey` (browser) or `apiKey` (server) value and key status |
| `tenant_not_found` | API returned 404 | Verify `tenantId` value |

## Interaction Errors

| Error | Context | Meaning |
|---|---|---|
| `interaction_tracking_failed` | `trackTreatmentInteraction()` | Event delivery failed — silently dropped |
| `event_delivery_failed` | `trackEvent()` | Custom event could not be sent — buffered for retry |
| `network_error` | Interaction-flush fetch | The touchpoint-transition request threw (offline, DNS, CORS) — the batch is re-queued and retried |

## Storage Errors

| Error | Context | Meaning |
|---|---|---|
| `storage_unavailable` | localStorage/sessionStorage | Browser storage not accessible — using in-memory fallback |
| `storage_quota_exceeded` | `setItem()` failed | Clear old entries or use custom storage provider |

## Debugging

Enable verbose logging to see all reason codes and errors:

```ts
localStorage.setItem('revturbine:debug', 'true');
```

Errors and reason codes are also available programmatically:

```tsx
const { decision, error } = usePlacement({ placement: { name: 'hero_banner' } });

// Hook-level error (string)
console.log(error);

// Decision-level reason codes
console.log(decision?.reasonCodes);
```

## Related

- [Error Handling Guide](/guides/error-handling/) — patterns and strategies
