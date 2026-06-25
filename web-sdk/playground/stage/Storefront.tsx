import { PRISM_CONFIG } from '../config/prism-config';
import type { PrismPlanHandle } from '../state/demo-state';
import { isPrismPlanHandle } from '../state/demo-state';

/**
 * Playground-owned conversion surfaces (plan 81 TASK-4). These are NOT SDK
 * placements — they are the destinations a CTA routes to (the customer app owns
 * its own checkout / pricing / sales pages). The point is that a placement CTA
 * leads somewhere that completes the loop.
 */
interface PlansModalProps {
  currentPlan: PrismPlanHandle;
  /** Whether the current user can self-serve upgrade (a buyer). Non-buyers are
   *  routed to "contact your admin" instead of Choose. */
  canUpgrade: boolean;
  onChoose: (plan: PrismPlanHandle) => void;
  onContactSales: () => void;
  onContactAdmin: () => void;
  onClose: () => void;
}

const ORDER: PrismPlanHandle[] = ['free', 'pro', 'enterprise'];
const PRICE: Record<PrismPlanHandle, string> = { free: 'Free', pro: '$19/mo', enterprise: 'Custom' };

/** Feature comparison rows — values mirror the Prism config entitlement rules. */
const FEATURES: ReadonlyArray<{ label: string; values: Record<PrismPlanHandle, string> }> = [
  { label: 'Generations / month', values: { free: '30', pro: '2,000', enterprise: 'Unlimited' } },
  { label: 'Style credits', values: { free: '20 to start', pro: '1,000 / mo', enterprise: 'Unlimited' } },
  { label: 'Resolution', values: { free: 'Watermarked 720p', pro: 'Clean 4K', enterprise: 'Clean 4K' } },
  { label: 'Premium styles', values: { free: '—', pro: '✓', enterprise: '✓' } },
  { label: 'Batch export', values: { free: '—', pro: '✓', enterprise: '✓' } },
  { label: 'Team seats', values: { free: '1', pro: '5', enterprise: 'Unlimited' } },
  { label: 'Generation rate', values: { free: '3 / min', pro: '30 / min', enterprise: 'Unlimited' } },
  { label: 'Overage', values: { free: '—', pro: '$0.05 / image', enterprise: '$0.03 / image' } },
];

/** Plan comparison surface — the `view_plans` / `navigate_to_plans` destination. */
export function PlansModal({ currentPlan, canUpgrade, onChoose, onContactSales, onContactAdmin, onClose }: PlansModalProps) {
  const name = (h: PrismPlanHandle) =>
    PRISM_CONFIG.plans.find((p) => p.unique_handle === h)?.name ?? h;

  return (
    <div className="prism-modal__overlay" role="dialog" aria-modal="true">
      <div className="prism-modal prism-modal--wide">
        <h3 className="prism-modal__title">Plans &amp; pricing</h3>
        <table className="prism-pricing">
          <thead>
            <tr>
              <th />
              {ORDER.map((h) => (
                <th key={h} className={h === currentPlan ? 'is-current' : undefined}>
                  <span className="prism-pricing__plan">{name(h)}</span>
                  <span className="prism-pricing__price">{PRICE[h]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURES.map((f) => (
              <tr key={f.label}>
                <th scope="row">{f.label}</th>
                {ORDER.map((h) => (
                  <td key={h} className={h === currentPlan ? 'is-current' : undefined}>
                    {f.values[h]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              {ORDER.map((h) => (
                <td key={h} className={h === currentPlan ? 'is-current' : undefined}>
                  {h === currentPlan ? (
                    <span className="prism-plan__badge">Current</span>
                  ) : h === 'enterprise' ? (
                    <button className="prism-btn prism-btn--small" onClick={onContactSales}>
                      Contact sales
                    </button>
                  ) : canUpgrade ? (
                    <button
                      className="prism-btn prism-btn--small prism-btn--primary"
                      onClick={() => onChoose(isPrismPlanHandle(h) ? h : 'free')}
                    >
                      Choose
                    </button>
                  ) : (
                    // Non-buyer: no purchase authority — route to their admin.
                    <button className="prism-btn prism-btn--small" onClick={onContactAdmin}>
                      Contact your admin
                    </button>
                  )}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
        <div className="prism-modal__actions">
          <button className="prism-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Non-buyer admin gate — shown when a user without purchase authority tries to
 * upgrade/top-up. The `contact_admin` destination.
 */
export function ContactAdminModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="prism-modal__overlay" role="dialog" aria-modal="true">
      <div className="prism-modal">
        <h3 className="prism-modal__title">Ask your admin to upgrade</h3>
        <p className="prism-modal__body">
          Only an account admin can change your plan or buy credits. We&apos;ve let your admin know
          you&apos;d like to upgrade — they can approve it from billing settings.
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
