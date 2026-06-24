import { PRISM_CONFIG } from '../config/prism-config';
import type { PrismPlanHandle } from '../state/demo-state';
import { isPrismPlanHandle } from '../state/demo-state';

/**
 * Playground-owned conversion surfaces (plan 81 TASK-4). These are NOT SDK
 * placements — they are the destinations a CTA routes to (the customer app owns
 * its own checkout / pricing / sales pages). Kept deliberately simple; the point
 * is that a placement CTA leads somewhere that completes the loop.
 */
interface PlansModalProps {
  currentPlan: PrismPlanHandle;
  onChoose: (plan: PrismPlanHandle) => void;
  onContactSales: () => void;
  onClose: () => void;
}

const PLAN_BLURB: Record<PrismPlanHandle, string> = {
  free: '30 generations/mo · 20 style credits · watermarked 720p',
  pro: '2,000 generations/mo · 1,000 credits · clean 4K · batch export',
  enterprise: 'Unlimited generations & credits · everything in Pro',
};

/** Plan comparison surface — the `view_plans` / `navigate_to_plans` destination. */
export function PlansModal({ currentPlan, onChoose, onContactSales, onClose }: PlansModalProps) {
  const plans = [...PRISM_CONFIG.plans].sort((a, b) => a.tier_position - b.tier_position);
  return (
    <div className="prism-modal__overlay" role="dialog" aria-modal="true">
      <div className="prism-modal prism-modal--wide">
        <h3 className="prism-modal__title">Plans &amp; pricing</h3>
        <div className="prism-plans">
          {plans.map((plan) => {
            const handle = isPrismPlanHandle(plan.unique_handle) ? plan.unique_handle : 'free';
            const isCurrent = handle === currentPlan;
            return (
              <div key={plan.id} className={`prism-plan${isCurrent ? ' is-current' : ''}`}>
                <h4>{plan.name}</h4>
                <p className="prism__muted">{PLAN_BLURB[handle]}</p>
                {isCurrent ? (
                  <span className="prism-plan__badge">Current plan</span>
                ) : handle === 'enterprise' ? (
                  <button className="prism-btn" onClick={onContactSales}>
                    Contact sales
                  </button>
                ) : (
                  <button className="prism-btn prism-btn--primary" onClick={() => onChoose(handle)}>
                    Choose {plan.name}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="prism-modal__actions">
          <button className="prism-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Contact-sales surface — the `contact_sales` destination (Enterprise). */
export function ContactModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="prism-modal__overlay" role="dialog" aria-modal="true">
      <div className="prism-modal">
        <h3 className="prism-modal__title">Talk to sales</h3>
        <p className="prism-modal__body">
          Enterprise unlocks unlimited generations and credits, SSO, and dedicated support. A
          specialist will reach out to scope your team&apos;s needs.
        </p>
        <div className="prism-modal__actions">
          <button className="prism-btn prism-btn--primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
