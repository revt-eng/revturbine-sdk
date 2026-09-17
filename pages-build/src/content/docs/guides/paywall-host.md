---
title: Paywall Host Pattern
description: One always-mounted slot, a paywall store, and a 402 to slot map — the reference architecture for gating a whole app.
sidebar:
  order: 13
---

Most apps need a paywall in more than one place: a feature button, a quota
ceiling hit mid-action, a server rejecting a request. The obvious approach —
mount a slot everywhere a paywall might appear — scatters placement logic across
the codebase and makes it very hard to answer the one question that matters when
something doesn't show up: *is this slot mounted right now?*

The paywall host pattern inverts that. **One slot, mounted once, always.** Every
other part of the app asks a store to open it.

## The three pieces

### 1. One always-mounted slot

Mount a single `FixedSurfaceSlot` — the fixed-category variant of [`<Slot>`](/guides/placements/#slot-types),
with an `onDismissed` callback — high in the tree: in your root layout, above
the router, so it is mounted on every route.

```tsx
// app/layout.tsx
import { FixedSurfaceSlot } from '@revturbine/sdk';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <RevTurbineProvider options={options}>
      {children}
      {/* Mounted once, on every route. Nothing else in the app mounts a paywall. */}
      <FixedSurfaceSlot id="slot_paywall" />
    </RevTurbineProvider>
  );
}
```

Because it is always mounted, "the slot wasn't there" stops being a possible
explanation for a paywall that didn't appear. That removes an entire class of
debugging.

### 2. A paywall store

The store holds *why* the paywall should be open, not *what* to render — the
content comes from the Playbook.

The store below uses only React — no state library — because the one property
that matters is awkward to get from a hook alone: it must be **settable from
outside React**, so a `fetch` wrapper can open the paywall. Zustand, Redux,
signals or Context all work; swap this for whatever your app already uses.

```tsx
// lib/use-paywall.ts
import { useSyncExternalStore } from 'react';

let blockedEntitlement: string | null = null;
const listeners = new Set<() => void>();

/** Imperative half — callable from anywhere, including non-React code. */
export const paywall = {
  open(entitlementHandle: string): void {
    blockedEntitlement = entitlementHandle;
    listeners.forEach((listener) => listener());
  },
  close(): void {
    blockedEntitlement = null;
    listeners.forEach((listener) => listener());
  },
};

/** Reactive half — the entitlement the user bumped into, or null when closed. */
export function usePaywall(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => blockedEntitlement,
    // Server snapshot: nothing is open during SSR.
    () => null,
  );
}
```

Any component can now request a paywall without knowing anything about
placements:

```tsx
async function handleExport() {
  const result = await sdk.can('feature_export');
  if (!result.allowed) {
    paywall.open('feature_export');
    return;
  }
  await runExport();
}
```

### 3. A 402 → slot map

Client-side checks cover the cases the client knows about. The server is the
authority, and it will sometimes reject a request the client thought was fine —
a quota consumed on another device, a subscription that lapsed mid-session, a
race. Map that rejection back into the same paywall.

Entitlement checks fail **closed**, so a check that cannot complete denies rather
than grants. The server rejection and the client check agree on direction.

```ts
// lib/api-client.ts
import { paywall } from './use-paywall';

/** Which entitlement a 402 refers to, by the header the API sends back. */
const ENTITLEMENT_BY_CODE: Record<string, string> = {
  export_limit: 'feature_export',
  seat_limit: 'feature_seats',
  ai_credits: 'feature_ai_generation',
};

export async function apiFetch(input: RequestInfo, init?: RequestInit) {
  const response = await fetch(input, init);

  if (response.status === 402) {
    const code = response.headers.get('x-entitlement-code') ?? '';
    const handle = ENTITLEMENT_BY_CODE[code];
    if (handle) {
      paywall.open(handle);
    }
    // Fall through: the caller still sees a failed response and can render its
    // own inline state. The paywall opens in addition to, not instead of, the
    // caller's own error handling.
  }

  return response;
}
```

Keep the map explicit. A `402` with an unrecognized code should **not** silently
open a generic paywall — you will never find out the code was wrong, and the user
gets a paywall for something they can already do.

## Handling dismissal

A dismissal is not the same as "nothing matched". `FixedSurfaceSlot` renders its
`fallback` when no placement matches — correct for an always-present slot — and
renders nothing at all once the user dismisses. Use `onDismissed` to clear your
store so the app's own state agrees with what is on screen:

```tsx
<FixedSurfaceSlot
  id="slot_paywall"
  onDismissed={() => paywall.close()}
/>
```

Without this the store still believes a paywall is open after the user closed it,
and the next `open()` for the same entitlement looks like a no-op.

Dismissal is also remembered by the SDK: a dismissed placement stays suppressed
for its authored cooldown, and a **converted** one is retired permanently. Your
store does not need to track either — asking again is safe, and the SDK answers.

## Why a config-side audit cannot verify this

This is the part worth internalising, because we got it wrong ourselves.

When an integration reported that its paywalls never appeared, we audited the
Playbook: the placements existed, the entitlements existed, the targeting was
right, and the fixed slots were configured. We concluded the slots were not
mounted.

**They were mounted.** The call sites passed slot ids that no placement targeted
— a slot id typo on one side and a stale slot id on the other. The config was
fine and the mounting was fine; the two simply did not refer to the same slots.

A config-side audit **cannot see call sites**. It can tell you a placement
targets `slot_paywall`; it cannot tell you your code mounts `slot_paywall_v2`.
Both directions fail silently and they fail differently:

| situation | what you observe |
|---|---|
| A placement targets a slot no code mounts | **Nothing at all.** The decision path is never asked about a slot that was never mounted, so there is no error, no warning, and no reason code. |
| Code mounts a slot no placement targets | The fallback renders forever, which looks exactly like "the user isn't eligible". |

The paywall host pattern shrinks this problem to a single slot id, which is why
it is worth adopting on its own. To check the rest, ask the running app:

```ts
const diagnosis = sdk.diagnoseSlotInventory();

console.log(diagnosis.authoredButUnmounted); // placements that can never show
console.log(diagnosis.mountedButUnauthored); // slots that render fallback forever
```

`diagnoseSlotInventory()` diffs the Playbook's placement triggers against the
slots this app actually mounted, in both directions. Only the running app knows
what it mounted, so this check cannot live in config tooling.

Check `configAvailable` before believing an empty result. If no Playbook reached
the SDK, `authored` is empty for a completely different reason than "nothing is
authored", and the two are indistinguishable without it.

## Why one slot, restated

- **One id to get right.** The failure above becomes a single line to check.
- **One place to mount.** "Is it mounted?" is answered by reading the layout.
- **Routing lives in your app, targeting lives in the Playbook.** The store
  decides *when*; the Playbook decides *what* and *to whom*. Neither needs to
  know about the other.
- **Server and client agree.** A `402` and a failed `sdk.can()` open the same
  paywall through the same path, so there is one rendering to style, test, and
  measure.
