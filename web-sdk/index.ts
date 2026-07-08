/**
 * @module @revt-eng/sdk
 *
 * The RevTurbine customer-facing SDK — React integration.
 *
 * Re-exports everything from the headless (pure TypeScript) package plus
 * React-specific components, hooks, and context providers.
 *
 * ## Quick Start
 *
 * ```ts
 * import { initRevTurbine } from '@revt-eng/sdk';
 *
 * const sdk = initRevTurbine({
 *   tenantId: 'tenant_abc',
 *   apiKey: 'rt_live_xxx',
 *   endpoint: 'https://api.revturbine.io',
 *   mode: 'react',
 * });
 *
 * sdk.identify('user_123', { plan: 'pro' });
 * ```
 *
 * ## React Integration
 *
 * Wrap your app in `<RevTurbineProvider>` and use `usePlacement()` or
 * `<SurfaceSlotComponent>` to render server-driven placements.
 *
 * ## Headless (pure TypeScript)
 *
 * For non-React usage, import from `@revt-eng/web-sdk/headless`:
 * ```ts
 * import { initRevTurbine } from '@revt-eng/web-sdk/headless';
 * ```
 *
 * ## Modules
 *
 * - **Core SDK** — `RevTurbineCustomerSdk`, `initRevTurbine`
 * - **React** — `RevTurbineProvider`, `usePlacement`, `Placement`
 * - **Placements** — Registry, slot types, built-in components, surface-slot rendering
 * - **Schema types** — Canonical types from @revt-eng/schema (re-exported)
 */

// ── Headless core (pure TypeScript — no React) ──────────────────────────────
export * from './headless';

// ── React integration layer ─────────────────────────────────────────────────
export * from './react';

// ── React placement components, hooks, and slot rendering ───────────────────
export * from './placements';

// ── React theme context ─────────────────────────────────────────────────────
export * from './theme';

// Resolve ambiguity: the React Placement component and the generated Placement
// schema type both export the name 'Placement'. The component takes precedence
// for SDK consumers. Import the schema type from '@revt-eng/schema' directly.
export { Placement } from './react/Placement';

// Resolve ambiguity: surface-slot constants are exported from both headless
// (placements/surface-slot-constants) and placements barrel. Prefer the
// headless export so both entry points share the same source.
export {
  FIXED_SURFACE_TEMPLATE_IDS,
  GATED_SURFACE_TEMPLATE_IDS,
  MESSAGE_SURFACE_TEMPLATE_IDS,
} from './placements/surface-slot-constants';

// Advertised names (plan 105 Q-4): the customer-facing components are just two —
// `<Slot>` and `<Gate>`. `Slot` IS `SurfaceSlotComponent`; `Gate` IS
// `AccessGateSurfaceSlot` (both canonical names remain exported via
// `export * from './placements'` above).

/**
 * `<Slot id="…" />` — the general placement slot component. Renders whatever
 * placement the control plane resolves for the given surface (banner, modal,
 * toast, meter, …). Advertised name for `SurfaceSlotComponent`.
 */
export { SurfaceSlotComponent as Slot } from './placements/SurfaceSlotComponent';
export type { SurfaceSlotComponentProps as SlotProps } from './placements/SurfaceSlotComponent';

/**
 * `<Gate check={{ entitlement: "…" }}>` — gates its children behind an
 * entitlement, rendering the resolved upsell placement when denied. Advertised
 * name for `AccessGateSurfaceSlot`.
 */
export { AccessGateSurfaceSlot as Gate } from './placements/AccessGateSurfaceSlot';
export type { AccessGateSurfaceSlotProps as GateProps } from './placements/AccessGateSurfaceSlot';

// Deprecated prior name (plan 84): `<RTSlot>` predates the plan-105 `<Slot>`
// rename. Kept as a back-compat alias of `SurfaceSlotComponent`; prefer `Slot`.
/** @deprecated Use {@link Slot} instead — `RTSlot` is the pre-plan-105 name. */
export { SurfaceSlotComponent as RTSlot } from './placements/SurfaceSlotComponent';
export type { SurfaceSlotComponentProps as RTSlotProps } from './placements/SurfaceSlotComponent';
