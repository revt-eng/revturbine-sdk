import { usePlacement } from '../../index';
import { useDemo } from '../state/DemoProvider';
import { PRISM_CONFIG } from '../config/prism-config';
import { pickSmartRail, type SmartRailPick } from '../state/smart-rail';
import { authoredCta, isPurchaseCta, CONTACT_ADMIN_LABEL, type CtaPath } from '../state/cta-actions';
import { interpolate } from '../state/active-nudges';
import { overagePriceFor } from '../state/derived';
import { WhyTrace } from './WhyTrace';

/**
 * The smart rail (bottom-left): a single fixed-size slot that surfaces the one
 * most-urgent monetization moment — usage, credits, or trial proximity — once
 * it crosses the warning band, with the Explore-Pro card as the gentle default.
 * The winner is chosen by {@link pickSmartRail} (proximity ranking, mirroring
 * the engine); the card uses the chosen placement's authored copy + CTA + the
 * "why am I seeing this?" trace, overlaid with the live counter.
 */
export function SmartRail({ onCta }: { onCta: (cta: CtaPath) => void }) {
  const { state } = useDemo();
  const pick = pickSmartRail(PRISM_CONFIG, state);
  // Enterprise is the top tier — with no warning to surface there's nothing to
  // upsell, so the rail stays empty rather than nagging the highest plan.
  if (pick.kind === 'explore' && pick.plan === 'enterprise') return null;
  return <SmartRailCard pick={pick} onCta={onCta} canUpgrade={state.custom.has_purchased} />;
}

const LABEL: Record<SmartRailPick['kind'], string> = {
  usage: 'Generations',
  credit: 'Style credits',
  trial: 'Pro trial',
  explore: '',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Sensible copy when the chosen placement isn't resolvable on the current plan. */
function fallbackCopy(pick: SmartRailPick): { header: string; body: string } {
  const over = pick.proximity >= 100;
  switch (pick.kind) {
    case 'usage':
      if (pick.overage) {
        const price = pick.plan ? overagePriceFor(PRISM_CONFIG, pick.plan) : null;
        const per = price ? `$${(price.amountCents / 100).toFixed(2)} each` : 'per image';
        return { header: "You're in overage", body: `Extra generations are billed ${per}. A higher plan includes more.` };
      }
      return over
        ? { header: "You're out of generations", body: 'Upgrade to Pro for 2,000 a month.' }
        : { header: 'Running low on generations', body: `${pick.used} of ${pick.limit} used this month.` };
    case 'credit':
      return over
        ? { header: 'Out of style credits', body: 'Top up or upgrade to keep using premium styles.' }
        : { header: 'Style credits running low', body: `${(pick.limit ?? 0) - (pick.used ?? 0)} of ${pick.limit} left.` };
    case 'trial':
      return {
        header: `Your Pro trial ends in ${pick.daysRemaining} day${pick.daysRemaining === 1 ? '' : 's'}`,
        body: 'Keep Pro to stay on 4K and 2,000 generations a month.',
      };
    default:
      // The Explore default upsells the *next* tier above the user's plan.
      return pick.plan === 'pro'
        ? { header: 'Unlock more with Enterprise', body: 'Unlimited seats, custom styles, and priority generation.' }
        : { header: 'Unlock more with Pro', body: '4K exports, premium styles, and 2,000 generations a month.' };
  }
}

function SmartRailCard({ pick, onCta, canUpgrade }: { pick: SmartRailPick; onCta: (cta: CtaPath) => void; canUpgrade: boolean }) {
  const { content, visible } = usePlacement({ placement: { name: pick.placementId } });
  const overage = pick.plan ? overagePriceFor(PRISM_CONFIG, pick.plan) : null;
  const tokens = {
    usage_remaining: String(Math.max(0, (pick.limit ?? 0) - (pick.used ?? 0))),
    usage_limit: String(pick.limit ?? 0),
    days_remaining: String(pick.daysRemaining ?? 0),
    overage_price: overage ? `$${(overage.amountCents / 100).toFixed(2)}` : '',
  };
  const read = (key: string): string => {
    // Only trust the placement's content when it actually resolved for this
    // user — otherwise the SDK returns a "Placement not configured" fallback.
    if (!visible || !isRecord(content)) return '';
    const raw = content[key];
    return typeof raw === 'string' ? interpolate(raw, tokens) : '';
  };
  const fb = fallbackCopy(pick);
  const isExplore = pick.kind === 'explore';
  // The default Explore card uses a clean promo (not the placement's "Welcome
  // to Prism" greeting) and routes to the pricing table; warnings use their
  // authored copy + CTA.
  const header = isExplore ? fb.header : read('header') || fb.header;
  const body = isExplore ? fb.body : read('body') || fb.body;
  const cta = authoredCta(PRISM_CONFIG, pick.placementId, 0) ?? { type: 'view_plans', params: {} };
  // Non-buyers can't self-upgrade — a purchase CTA reads "Contact your admin".
  const ctaLabel =
    !canUpgrade && isPurchaseCta(cta)
      ? CONTACT_ADMIN_LABEL
      : isExplore
        ? 'See plans & pricing'
        : read('cta_label') || 'Upgrade to Pro';

  const showMeter = pick.kind === 'usage' || pick.kind === 'credit';
  const pct = Math.min(100, pick.proximity);

  return (
    <div className={`prism-rail-card prism-rail-card--${pick.kind}${pick.proximity >= 100 ? ' is-critical' : ''}`}>
      {showMeter && (
        <div className="prism-rail-card__meter">
          <div className="prism-rail-card__meter-head">
            <span>{LABEL[pick.kind]}</span>
            <strong>
              {pick.used} / {pick.limit}
            </strong>
          </div>
          <div className="prism-rail-card__bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {pick.kind === 'trial' && (
        <div className="prism-rail-card__meter">
          <div className="prism-rail-card__meter-head">
            <span>{LABEL.trial}</span>
            <strong>{pick.daysRemaining}d left</strong>
          </div>
          <div className="prism-rail-card__bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      <strong className="prism-rail-card__title">{header}</strong>
      {body && <span className="prism-rail-card__body">{body}</span>}
      <button className="prism-btn prism-btn--small prism-btn--primary" onClick={() => onCta(cta)}>
        {ctaLabel}
      </button>
      <WhyTrace id={pick.placementId} />
    </div>
  );
}
