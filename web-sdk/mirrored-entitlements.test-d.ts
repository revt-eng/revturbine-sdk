/**
 * Type-level fixtures for mirrored `user.entitlements` (ST-1696 C5, SDK 0.16.0).
 *
 * The documented Entitlement Mirroring shape is a boolean or a record of
 * optional `status`, `allowed`, `limit`, `used`, `remaining`, `reason` — what
 * the runtime already reads. It must compile through every entry point that
 * takes a user context, with no `entitlement_id` / `entitlement_handle`.
 * Checked by `tsc` (`pnpm check:types:exact`).
 */
import { initRevTurbine } from './customer-side';
import type { RevTurbineCustomerSdk } from './customer-side';

const mirrored = {
  export: { allowed: true, remaining: 3 },
  seats: { status: 'limited', limit: 5, used: 5 },
  sso: true,
} as const;

declare const sdk: RevTurbineCustomerSdk;
const transport = { publicKey: 'rtk_test', endpoint: 'https://edge.example.com', mode: 'react' } as const;

// init
initRevTurbine({ ...transport, user: { id: 'u1', entitlements: { export: { allowed: true, remaining: 3 }, seats: { status: 'limited', limit: 5, used: 5 }, sso: true } } });
initRevTurbine({ ...transport, user: { id: 'u1', entitlements: mirrored } });
// identify
sdk.identify('u1', { entitlements: { export: { allowed: true, remaining: 3 }, sso: true } });
// update
sdk.update({ entitlements: { export: { allowed: true, remaining: 3 }, seats: { status: 'limited', limit: 5, used: 5 }, sso: true } });
// setUserContext
sdk.setUserContext({ entitlements: { export: { allowed: false, reason: 'plan' }, sso: true } });

// A field the shape does not declare is still rejected.
// @ts-expect-error - `quota` is not a mirrored-entitlement field.
sdk.update({ entitlements: { export: { quota: 3 } } });

// What `getUserContext()` hands back reads the same shape.
const held: Record<string, boolean | { allowed?: boolean; remaining?: number }> = sdk.getUserContext().entitlements;
void held;
