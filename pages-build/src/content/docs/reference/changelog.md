---
title: Changelog
description: Version history, breaking changes, and migration notes for the RevTurbine SDK.
---

## Versioning

The SDK follows [Semantic Versioning](https://semver.org/):

- **Major** — breaking changes that require code updates
- **Minor** — new features, backward-compatible
- **Patch** — bug fixes, backward-compatible

## Unreleased

### Behaviour change — read this one

- **A user with no resolvable plan now gets DENIED, not granted.** This is a
  fix, and it changes decisions: if the SDK could not resolve a plan identity,
  the evaluator used to *skip* plan targeting rather than fail it, so every
  plan-targeted rule matched and a plan-gated entitlement returned
  `allowed: true`. A pro-only feature was reachable by a user with no plan.

  The check now returns
  `{ status: 'denied', allowed: false, reason: 'no_plan_identity' }`. That
  reason is deliberately distinct from `no_matching_entitlement_rule`: the
  first means *we could not tell what plan this user is on* — an integration
  problem — and the second means *their plan does not include this*, which is
  the system working. If denials appear after upgrading, check `reason` before
  assuming the entitlement config is wrong.

  Most likely cause of a new `no_plan_identity`: still passing the `plan.id`
  shape retired in 0.3.0. Pass `plan_handle: 'pro'` or
  `plan: { handle, name }`.

  The same defect existed one level up, and is also fixed: the no-provider
  fallback path discarded the plan handle entirely, so it evaluated
  plan-targeted rules against no plan at all.

### Breaking changes

- **A plan's identity is its `unique_handle`, never its `id`.** Pass
  `plan_handle: 'pro'`, or `plan: { handle: 'pro', name: 'Pro' }` — the plan
  object's identity field is renamed `id` → `handle`. `plan.id` is a
  database-internal identifier the client often does not have, and it no longer
  participates in matching anywhere: React SDK, headless TypeScript, Python, or
  Rust. A user context whose only plan signal is `plan.id` now matches no
  plan-targeted rule and **fails closed**, instead of silently having no plan
  and missing every rule.

  ```diff
  - rt.identify('user_123', { plan: { id: 'pro', name: 'Pro' } })
  + rt.identify('user_123', { plan_handle: 'pro' })
  ```

- **Unknown user-context keys are now a compile error.** `identify()` no longer
  accepts an arbitrary traits bag, and the exactness survives un-annotated
  intermediates (a bare `useMemo`, a helper's return value). Pass free-form
  customer values explicitly under `custom`, via `update()`. This closes the
  failure mode where `user: { id, context: { plan_handle } }` type-checked,
  landed at `custom.context.plan_handle`, and left the user with no plan in
  production with no error at compile time or runtime.

- **The SDK no longer reads or writes `userContext.custom` for its own
  semantics.** `custom` is a pure customer pass-through. If you were relying on
  the SDK-written `custom.plan_handle` alias, move to the first-class field.

- **Reason code renamed: `local_runtime_default_allow` →
  `entitlement_not_in_playbook`.** No deprecated alias — update any `switch` on
  the old string. The old name stated a verdict the result does not have (it
  denies), and was *also* emitted by the headless runtime on an allowed result,
  so one code meant opposite things on two surfaces. Relatedly, the headless
  runtimes' terminal fallback now **denies** where it used to grant.

- JavaScript package installation and Node-based tooling now require Node.js
  22.13 or newer. Node.js 20 is no longer supported.

### Fixed

- **The Python and Rust server SDKs denied entitlements the TypeScript SDK
  granted.** Both ports resolved entitlements and plans by `id` *or*
  `unique_handle` — a resolution TypeScript dropped some time ago — and then
  matched rules against the record's database id rather than its handle. On any
  Playbook whose ids differ from its handles (every real export), every rule
  missed and every check failed closed. Cross-language parity now covers the
  evaluator directly, so the three languages are byte-identical on it.

### Added

- `clientSession: () => Promise<string>` init option. Supply a callback that
  mints an `rt_client_` session token and the SDK ingests server-derived plan,
  trial, and payment state automatically — invoked lazily on first need and
  re-invoked on expiry, with no further application code.

### Added

- `previewMode` init option. Set `previewMode: true` when an SDK instance is a
  non-install render — a docs example, a live playground, a component preview —
  to keep it out of SDK-adoption telemetry. Its only current effect is to
  suppress the keyless anonymous `sdk_init` beacon.

### Changed

- The keyless anonymous `sdk_init` beacon now fires in **`local_only`** runtime
  mode as well (a bundled-Playbook install is still a real install worth
  counting). It remains keyless, PII-free, config-shape counts only, and off
  when `anonymousTelemetry: false` or `previewMode: true`. The authed
  `/api/track` clickstream is unchanged and still makes no network call in
  `local_only`.

---

## 0.1.x (Current)

### 0.1.0 — Initial Release

**Features:**

- `RevTurbineProvider` with React integration
- `usePlacement`, `useEntitlement`, `useUsageSnapshot`, `useRevTurbineTheme` hooks
- 11 built-in slot components (banner, modal, toast, inline embed, button, quota meter, full page, CLI, credit balance, tooltip, agent connector)
- `FixedSurfaceSlot`, `AccessGateSurfaceSlot`, `MessageSurfaceSlot` component variants
- `PlacementController`, `EntitlementGate`, `SdkSession` headless controllers
- Three runtime modes: `revturbine_server`, `local_only`, `custom_endpoints`
- Playbook-based local runtime
- Theme system with color, typography, shape, and shadow tokens
- `PlacementTypeRegistry` for custom slot registration
- Event tracking: `trackEvent()`, `emitTrigger()`, `trackTreatmentInteraction()`
- Decision caching with configurable TTL
- Client-side cap enforcement
- Impression history and suppression management
- localStorage persistence with custom storage support
- Fail-open error handling — **reversed in 0.2.29**: entitlement checks are
  fail-*closed*. A check that cannot produce an affirmative grant denies rather
  than granting, and the `reason` names the cause. Listed here as the 0.1.0
  behaviour for historical accuracy; see
  [Error handling](/guides/error-handling/) for current semantics.
- TypeScript types for all public APIs

**Runtime compatibility:**

- React 18+
- Node.js 20+ (server SDK, at initial release)
- Chrome/Firefox/Safari/Edge 90+

---

## Migration Notes

### Migrating from Local to Server Mode

See [Runtime Modes → Migrating from Local to Server Mode](/guides/runtime-modes/) for step-by-step instructions.

### Schema Version Compatibility

The SDK version is tied to the RevTurbine schema version it bundles. When upgrading the SDK, ensure your Playbook fixture is compatible:

```bash
# Regenerate types after SDK upgrade
pnpm add @revturbine/sdk@latest
```

---

## Upcoming

Features planned for upcoming releases. Subject to change.

- **A/B testing integration** — experiment assignment and variant tracking
- **Offline mode** — queue events and decisions when offline
- **React Server Components** — first-class RSC support
- **Web Component mode** — framework-agnostic custom elements

---

## Related

- [Compatibility Matrix](/reference/compatibility/) — supported browsers, runtimes, and features
- [Configuration Reference](/reference/configuration/) — full options specification
