---
title: Error Codes
description: Enumerated error and reason codes returned by the SDK, with causes and fixes.
---

This page lists all error and reason codes the SDK may return, organized by category.

## Placement Reason Codes

Returned in `decision.reason_codes[]` to explain why a placement was or wasn't shown.

| Code | Meaning | Fix |
|---|---|---|
| `cap_limit_exceeded` | Impression cap reached (session/day/week/month/lifetime) | Increase cap in dashboard or wait for period reset |
| `suppressed` | User recently dismissed, snoozed, or completed CTA | Wait for cooldown to expire |
| `plan_mismatch` | User's plan doesn't match placement targeting | Verify targeting rules or user context |
| `segment_mismatch` | User doesn't match the required segment | Check segment definitions |
| `config_not_loaded` | Playbook not yet available | Ensure provider initialized before rendering slots |
| `api_error` | API returned non-200 response | Check endpoint URL, API key, and network connectivity |
| `network_error` | Network timeout or unreachable endpoint | Verify endpoint is accessible from client |
| `fallback_content` | Using fallback placeholder content | Provider failure — check API connectivity |
| `no_matching_template` | Slot's `surfaceTemplateIds` don't match any available template | Verify template IDs match dashboard config |
| `no_matching_placement` | No placement rules match the current user | Expected — slot renders nothing for this user |

## Entitlement Reason Codes

Returned in `result.reason` to explain the entitlement check outcome.

Entitlement checks are **fail-closed**: when the SDK cannot produce an
affirmative grant it denies and names the cause. This is the complete emitted
set — see [Error handling](/guides/error-handling/) for the enforcement-mode
suffixes on the two limit codes.

| Code | Meaning | Fix |
|---|---|---|
| `no_matching_entitlement_rule` | No rule grants this entitlement to the user's plan — check **denied** | Add an entitlement rule targeting that plan, or check the user's `plan_handle` is the plan's `unique_handle` |
| `feature_not_enabled_for_plan` | A matching `feature` rule has `enabled: false` — check **denied** | Enable the rule for that plan, or upgrade the user |
| `usage_limit_reached` | At or over a `usage_limit` rule's limit | Report accurate usage via `updateUsage()`; raise the limit or change `enforcement` |
| `credit_balance_exhausted` | At or over a `credits` rule's allowance | Grant more credits or change `enforcement` |
| `config_unavailable` | The launched Playbook could not be fetched (Server mode) — check **denied** | Check network connectivity; the reason distinguishes an outage from a real denial |
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
| `invalid_api_key` | API returned 401 | Check `apiKey` value and key status |
| `tenant_not_found` | API returned 404 | Verify `tenantId` value |

## Interaction Errors

| Error | Context | Meaning |
|---|---|---|
| `interaction_tracking_failed` | `trackTreatmentInteraction()` | Event delivery failed — silently dropped |
| `event_delivery_failed` | `trackEvent()` | Custom event could not be sent — buffered for retry |

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
console.log(decision?.reason_codes);
```

## Related

- [Error Handling Guide](/guides/error-handling/) — patterns and strategies
