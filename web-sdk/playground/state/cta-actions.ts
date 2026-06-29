import type { RevTurbineConfig } from '@revt-eng/schema';
import type { BillingPeriod, PrismPlanHandle } from './demo-state';

/**
 * The demo-side effects a placement CTA can drive (plan 81 TASK-4). The
 * playground implements these against `DemoState` so a CTA visibly completes the
 * monetization loop: upgrading flips entitlements, tops up credits, switches
 * billing, or opens a plan / contact surface — and every placement re-resolves.
 */
export interface DemoActions {
  upgradeTo(plan: PrismPlanHandle): void;
  topUpCredits(amount: number): void;
  switchBillingPeriod(period: BillingPeriod): void;
  openPlans(): void;
  contactSales(): void;
  /** A non-buyer tried to purchase — only an account admin can change the plan. */
  contactAdmin(): void;
  fixPayment(): void;
  note(label: string): void;
}

/** Shared label for the non-buyer admin gate. */
export const CONTACT_ADMIN_LABEL = 'Contact your admin';

/**
 * CTA actions that commit a purchase (upgrade, top-up, switch to annual). These
 * are gated for non-buyers — a user without purchase authority can browse plans
 * but is routed to "contact your admin" instead of self-serve checkout.
 * Viewing plans / contacting sales / fixing payment are NOT purchases.
 */
const PURCHASE_CTA_TYPES = new Set(['open_checkout', 'open_checkout_modal', 'switch_billing_period']);

export function isPurchaseCta(cta: CtaPath): boolean {
  return PURCHASE_CTA_TYPES.has(cta.type);
}

/**
 * A resolved CTA action: the authored `path` (action type) + its config params.
 * Params are `unknown`-valued so both authored config (string map) and the SDK's
 * parsed `uiPath.params` flow through the same dispatcher.
 */
export interface CtaPath {
  type: string;
  params: Record<string, unknown>;
}

/** How many style credits a top-up pack grants in the demo. */
export const CREDIT_PACK_SIZE = 20;

/** Read a placement's authored CTA (primary `index` 0, secondary 1) from the config. */
export function authoredCta(config: RevTurbineConfig, placementId: string, index = 0): CtaPath | null {
  const cta = (config.placements ?? []).find((p) => p.id === placementId)?.payloads?.[0]?.surfaces?.[0]?.ctas?.[index];
  if (!cta) return null;
  return { type: cta.path, params: cta.config ?? {} };
}

/**
 * Perform the in-demo effect of a CTA. Mutating `DemoState` (via {@link DemoActions})
 * causes the SDK subtree to re-resolve, so the consequence is visible: gates
 * clear, the watermark drops, quota jumps, the annual nudge stops firing, etc.
 */
export function dispatchCta(cta: CtaPath, actions: DemoActions): void {
  const purchase = typeof cta.params.purchase === 'string' ? cta.params.purchase : undefined;
  switch (cta.type) {
    case 'open_checkout':
    case 'open_checkout_modal':
      if (purchase === 'credit_pack') {
        actions.topUpCredits(CREDIT_PACK_SIZE);
        actions.note(`Bought a Style Credits pack (+${CREDIT_PACK_SIZE})`);
      } else {
        actions.upgradeTo('pro');
        actions.note('Completed checkout — upgraded to Pro');
      }
      break;
    case 'switch_billing_period':
      actions.switchBillingPeriod('annual');
      actions.note('Switched to annual billing');
      break;
    case 'view_plans':
    case 'navigate_to_plans':
      actions.openPlans();
      actions.note('Opened plans & pricing');
      break;
    case 'contact_sales':
      actions.contactSales();
      actions.note('Opened contact sales');
      break;
    case 'contact_admin':
      actions.contactAdmin();
      actions.note('Asked your admin to upgrade');
      break;
    case 'update_payment_method':
      actions.fixPayment();
      actions.note('Updated payment method — billing restored');
      break;
    case 'dismiss':
      break;
    default:
      actions.note(`CTA: ${cta.type}`);
  }
}
