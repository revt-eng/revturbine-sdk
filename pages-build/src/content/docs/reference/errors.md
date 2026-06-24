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
| `config_not_loaded` | ExportedConfig not yet available | Ensure provider initialized before rendering slots |
| `api_error` | API returned non-200 response | Check endpoint URL, API key, and network connectivity |
| `network_error` | Network timeout or unreachable endpoint | Verify endpoint is accessible from client |
| `fallback_content` | Using fallback placeholder content | Provider failure — check API connectivity |
| `no_matching_template` | Slot's `surfaceTemplateIds` don't match any available template | Verify template IDs match dashboard config |
| `no_matching_placement` | No placement rules match the current user | Expected — slot renders nothing for this user |

## Entitlement Reason Codes

Returned in `result.reason` to explain the entitlement check outcome.

| Code | Meaning | Fix |
|---|---|---|
| `entitlement_service_unavailable` | API unreachable — defaulted to `allowed` | Check network connectivity; this is fail-open by design |
| `entitlement_check_error` | Parse or exception error — defaulted to `allowed` | Check entitlement handle spelling and context format |
| `local_runtime_default_allow` | Local mode with no matching entitlement data | Add entitlement to ExportedConfig fixture |
| `denied_feature_gate` | Feature not included in user's plan | Upgrade plan or adjust entitlement config |
| `denied_usage_limit` | Usage limit exceeded | Report accurate usage via `updateUsage()` |
| `denied_tier_mismatch` | User's plan tier insufficient | `result.tier` indicates minimum tier |

## Provider Errors

| Error | Source | Meaning |
|---|---|---|
| `provider_chain_exhausted` | All providers failed | Check API keys, endpoints, and network |
| `config_fetch_failed` | ExportedConfig could not be loaded | Verify `configProvider` or API endpoint |
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
const { decision, error } = usePlacement({ ... });

// Hook-level error (string)
console.log(error);

// Decision-level reason codes
console.log(decision?.reason_codes);
```

## Related

- [Error Handling Guide](/guides/error-handling/) — patterns and strategies
