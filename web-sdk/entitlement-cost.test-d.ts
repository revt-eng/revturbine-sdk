/**
 * Type-level fixtures for the per-call `cost` (ST-1696, SDK 0.16.0). Checked by
 * `tsc` (`pnpm check:types:exact`).
 */
import type { RevTurbineCustomerSdk } from './customer-side';
import type { AccessGateSurfaceSlotProps } from './placements/AccessGateSurfaceSlot';
import { useEntitlement } from './react/useEntitlement';
import { useCan } from './react/useCan';
import { useGatedAction } from './react/useGatedAction';

declare const sdk: RevTurbineCustomerSdk;

// Imperative surfaces take `cost` in the context.
void sdk.can('ai_generations', { cost: 3 });
void sdk.checkEntitlement('ai_generations', { cost: 0.5, used: 7 });
void sdk.checkEntitlement('ai_credits', { balance: 40, cost: 40 });
// @ts-expect-error - `cost` is a number.
void sdk.can('ai_generations', { cost: '3' });

// The result carries the optional diagnostic.
async function readDiagnostic(): Promise<void> {
  const result = await sdk.can('ai_generations', { cost: 1 });
  const code: 'entitlement_cost_zero' | 'entitlement_cost_missing' | 'entitlement_cost_invalid' | undefined =
    result.diagnostic?.code;
  void code;
}
void readDiagnostic;

// Hooks.
void useEntitlement({ handle: 'ai_generations', cost: 3 });
void useCan('ai_generations', { cost: 3 });
void useGatedAction('ai_generations', async () => 1, { cost: 3 });
// @ts-expect-error - `cost` is a number.
void useEntitlement({ handle: 'ai_generations', cost: '3' });

// `<Gate cost>`.
const props: Pick<AccessGateSurfaceSlotProps, 'cost'> = { cost: 3 };
void props;
