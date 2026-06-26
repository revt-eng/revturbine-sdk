---
title: Changelog
description: Version history, breaking changes, and migration notes for the RevTurbine SDK.
---

## Versioning

The SDK follows [Semantic Versioning](https://semver.org/):

- **Major** — breaking changes that require code updates
- **Minor** — new features, backward-compatible
- **Patch** — bug fixes, backward-compatible

## 0.1.x (Current)

### 0.1.0 — Initial Release

**Features:**

- `RevTurbineProvider` with React integration
- `usePlacement`, `useEntitlement`, `useUsageSnapshot`, `useRevTurbineTheme` hooks
- 11 built-in slot components (banner, modal, toast, inline embed, button, quota meter, full page, CLI, credit balance, tooltip, agent connector)
- `FixedSurfaceSlot`, `AccessGateSurfaceSlot`, `MessageSurfaceSlot` component variants
- `PlacementController`, `EntitlementGate`, `SdkSession` headless controllers
- Three runtime modes: `revturbine_server`, `local_only`, `custom_endpoints`
- ExportedConfig-based local runtime
- Theme system with color, typography, shape, and shadow tokens
- `PlacementTypeRegistry` for custom slot registration
- Event tracking: `trackEvent()`, `emitTrigger()`, `trackTreatmentInteraction()`
- Decision caching with configurable TTL
- Client-side cap enforcement
- Impression history and suppression management
- localStorage persistence with custom storage support
- Fail-open error handling
- TypeScript types for all public APIs

**Runtime compatibility:**

- React 18+
- Node.js 20+ (server SDK)
- Chrome/Firefox/Safari/Edge 90+

---

## Migration Notes

### Migrating from Local to Server Mode

See [Runtime Modes → Migrating from Local to Server Mode](/guides/runtime-modes/) for step-by-step instructions.

### Schema Version Compatibility

The SDK version is tied to the `@revt-eng/schema` package version. When upgrading the SDK, ensure your ExportedConfig fixture is compatible:

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
