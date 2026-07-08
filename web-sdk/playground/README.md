# Prism playground

**Prism** is a self-contained demo that drives the RevTurbine SDK against a
synthetic "AI image studio" — a breadth showcase of what RevTurbine can do, with
**zero backend and zero credentials** (the SDK runs in local-runtime mode against
a bundled `ExportedConfig`). It's the fastest way to *see* entitlements, usage
limits, credits, gates, nudges, trials, retention, and seats behave.

Built across plan 81 (capability breadth), plan 82 (trial-render fix), and plan 83
(app chrome + journey authoring) in `revturbine-devkit/docs/dev-lifecycle/`.

## Run it

```bash
pnpm playground        # vite dev server (web-sdk/playground/vite.config.ts)
```

Open the printed URL. No env vars, no login.

## What you're looking at

- **The Prism app** — the demo product's own chrome: an app bar (brand, nav, the
  persistent upgrade CTA, plan badge), a left sidebar (app nav + the usage rail
  where the quota meter and credit counter live), and the studio in the main area.
  Every SDK-driven surface and nudge renders *inside* this chrome so it reads as
  part of the app, not a demo overlay (usage/credit toasts + modals, gate modals,
  trial / payment-recovery / seat / annual banners).
- **Director** — a collapsible dev drawer (right), deliberately styled as *tooling*
  and visually distinct from the app. It moves a user through any monetization
  state: plan, generations used, credit balance, seats, the full segmentation
  trait set (email type, engagement, days since signup/active, purchased, billing
  status/period), and trial state (free / reverse). Collapse state persists across
  reloads. The seat-limit nudge fires by raising **Seats used** to the plan's cap.
- **Why am I seeing this?** — every surface has a collapsible trace naming the
  capability, the condition that fired it, and the defining spec.

## Advertised SDK API (plan 84)

The playground drives the SDK through the friendly, advertised surface from the
[developer-experience spec](../../../revturbine-devkit/docs/specs/sdk/sdk-developer-experience.md):

- **`<RTSlot id="…" />`** — every monetization surface renders through `<RTSlot>`
  (`shared/SlotHost.tsx`), the spec's name for `SurfaceSlotComponent`.
- **`gate(action, fn)`** — the studio's locked actions (Batch export, Premium style)
  run through `sdk.gate(...)`: it runs the action when entitled, else surfaces the
  paywall. `useEntitlement` (the React form of `can`) still drives the lock icon.
- **`track(event)`** — a successful generate emits `sdk.track('image_generated', …)`.

Two breadth capabilities also ship here (both within the published `ExportedConfig`):

- **Plan recommendation** — the out-of-generations modal reads its
  `recommendation_strategy` (`next_tier_up`) and shows "✨ We recommend Pro".
- **Per-unit overage price** — a `price_per_unit` entitlement (`generation_overage`)
  surfaces as "Overage $0.05/image" on Pro (none on Free, which hard-blocks).

## Journeys

A **journey** is a named, full `DemoState` that drops the user onto a recognisable
monetization moment in one click. The Director's **Journeys** group loads them
(grouped by set) and **Reset** returns to defaults. Journeys live as JSON under
[`journeys/`](./journeys/), one file per set; the built-in set ships these:

| Built-in journey | Shows |
|---|---|
| New free user | Baseline — sidebar + quota meter, no nudges |
| Usage cap approaching | 80% generations toast |
| Out of generations | 100% blocking modal |
| Credits running low | Credit-balance banner |
| Reverse trial active | Reverse-trial banner; premium unlocked on Free |
| Free trial ending | Trial-ending banner |
| Payment failed | Payment-recovery banner (retention) |
| Monthly Pro → annual | Annual-billing upsell banner |

### Authoring journeys

Set up any state in the Director, then under **Journeys → Save current state as…**
give it a name and pick a set (or **+ New set…**). Saving POSTs to a **dev-server-only**
write middleware that persists the set to `journeys/<set-id>.json` — so authored
journeys are committed to the codebase and available in future sessions. The save
appears in the picker immediately; sets added by editing files on disk show up on
the next reload. The **built-in** set is read-only (saves go to a user set). The
middleware only runs under `vite` dev (`apply: 'serve'`), validates the body, and
confines writes to the `journeys/` directory.

## Capabilities

See [`CAPABILITIES.md`](./CAPABILITIES.md) for the capability ↔ spec map and the
list of capabilities deferred for schema reasons.

## Editing the demo

- **The config** (`config/prism-export-config.json`) is **authored directly here** —
  edit it in place. It is no longer synced from revturbine-demo-data. Validate after
  editing:

  ```bash
  pnpm typecheck:prism-config       # build-time gate: parses it through RevTurbineConfigSchema
  ```

  A test (`config/prism-export-config.test.ts`) also validates it against
  `RevTurbineConfigSchema` and asserts the demo's capability breadth in CI.
- **Add a journey** — author it in the Director and **Save** (writes `journeys/<set>.json`),
  or hand-edit a JSON set directly. The model + loader live in `state/journeys.ts`
  (`state/journey-schema.ts` validates a set); the dev-write middleware is
  `dev/journey-writer.ts`, wired into `vite.config.ts`. `state/journeys.test.ts`
  asserts each built-in journey lands on its advertised placement.
- **A new placement needs a decision trace** — add it to `state/capability-trace.ts`;
  `state/capability-trace.test.ts` fails if any config placement is left untraced.
- **Which nudge fires for a given state** is decided by `state/active-nudges.ts` (the
  local resolver doesn't compare `threshold_percent` to live usage, so the playground —
  standing in for the customer app that owns usage tracking — picks the tier and resolves
  the placement by name).
