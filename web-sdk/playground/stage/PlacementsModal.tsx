import { PRISM_CONFIG } from '../config/prism-config';

/**
 * A plain-language reference of every placement in the Prism config, shown
 * inside the demo so a viewer can see the full catalogue without reading the
 * config. Derived from PRISM_CONFIG (stays in sync) but with cleaned-up,
 * handle-free wording. NOT an SDK surface — a demo reference view.
 */

const CATEGORY_LABEL: Record<string, string> = {
  gated: 'Gates',
  fixed: 'Always-on',
  usage_credit_seat: 'Usage, credits & seats',
  trials: 'Trials',
  other_conversion: 'Conversion',
  retention: 'Retention',
};

const CATEGORY_ORDER = ['gated', 'fixed', 'usage_credit_seat', 'trials', 'other_conversion', 'retention'];

const PLAN_LABEL: Record<string, string> = {
  plan_prism_free: 'Free',
  plan_prism_pro: 'Pro',
  plan_prism_enterprise: 'Enterprise',
};

const TEMPLATE_LABEL: Record<string, string> = {
  button: 'button',
  quota_meter: 'meter',
  credit_balance_counter: 'counter',
  modal_overlay: 'modal',
  inline_gate_message: 'inline note',
  toast_message: 'toast',
  banner_placement: 'banner',
  in_page_card: 'card',
};

/** Strip the internal code prefix ("V2: ", "D1: ", "NAV-1: ") from a name. */
function cleanName(name: string): string {
  return name.replace(/^[A-Z]+-?\d+:\s*/, '');
}

/** Plain-language "fires when" for a placement, from its trigger. */
function firesWhen(p: (typeof PRISM_CONFIG.placements)[number]): string {
  const t = p.trigger as { type: string; slot_id?: string; entitlement_handle?: string; threshold_percent?: number };
  const pct = t.threshold_percent;
  switch (t.type) {
    case 'surface_render':
      if (t.slot_id === 'sidebar') return 'New user (first few days)';
      return 'Always shown';
    case 'entitlement_gate':
      switch (t.entitlement_handle) {
        case 'batch_export': return 'Tries to batch export';
        case 'style_packs': return 'Tries a premium style';
        case 'resolution_tier': return 'Outputs are watermarked';
        case 'burst_rate': return 'Generates too fast (3/min)';
        default: return 'Feature is gated';
      }
    case 'usage_threshold':
      if (p.category === 'usage_credit_seat' && (p.payloads[0]?.target?.plan_ids ?? []).includes('plan_prism_pro')) {
        return 'Past included generations (overage)';
      }
      if (pct === 100) return 'Generations used up (100%)';
      return `Generations ${pct}% used`;
    case 'credit_threshold':
      if (pct === 100) return 'Style credits used up (100%)';
      return `Style credits ${pct}% consumed`;
    case 'seat_threshold':
      return 'All seats used';
    case 'trial_ending':
      return 'Free trial almost over';
    case 'trial_progress':
      return 'Reverse trial active';
    case 'qualifier':
      if (p.id === 'pl_payment_recovery') return 'Payment failed';
      if (p.id === 'pl_annual_nudge') return 'Monthly Pro (annual offer)';
      return 'Segment qualifies';
    default:
      return t.type;
  }
}

function who(p: (typeof PRISM_CONFIG.placements)[number]): string {
  const plans = (p.payloads[0]?.target?.plan_ids ?? []).map((id) => PLAN_LABEL[id] ?? id);
  return plans.length === 3 || plans.length === 0 ? 'All plans' : plans.join(' + ');
}

function showsAs(p: (typeof PRISM_CONFIG.placements)[number]): string {
  const tmpl = p.payloads[0]?.surfaces?.[0]?.template_id ?? '';
  return TEMPLATE_LABEL[tmpl] ?? tmpl;
}

export function PlacementsModal({ onClose }: { onClose: () => void }) {
  const byCategory = CATEGORY_ORDER.map((cat) => ({
    cat,
    label: CATEGORY_LABEL[cat] ?? cat,
    items: PRISM_CONFIG.placements
      .filter((p) => p.category === cat)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="prism-modal__overlay" role="dialog" aria-modal="true">
      <div className="prism-modal prism-modal--wide">
        <h3 className="prism-modal__title">Placements</h3>
        <p className="prism-modal__body">
          Every monetization surface RevTurbine can show in this app, and what makes each one appear.
        </p>
        <div className="prism-placements">
          {byCategory.map((g) => (
            <div key={g.cat} className="prism-placements__group">
              <h4 className="prism__group-title">{g.label}</h4>
              <ul className="prism-placements__list">
                {g.items.map((p) => (
                  <li key={p.id} className="prism-placements__row">
                    <span className="prism-placements__name">{cleanName(p.name)}</span>
                    <span className="prism-placements__when">{firesWhen(p)}</span>
                    <span className="prism-placements__meta">
                      {showsAs(p)} · {who(p)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
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
