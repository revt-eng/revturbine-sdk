import { useMemo, type ReactNode } from 'react';
import { usePlacement } from '../../index';
import { useDemo } from '../state/DemoProvider';
import { PRISM_CONFIG, RECOMMENDATION_PLACEMENT_IDS } from '../config/prism-config';
import { activeNudges, authoredSecondary, interpolate, type ActiveNudge, type NudgeSurface } from '../state/active-nudges';
import { authoredCta, type CtaPath } from '../state/cta-actions';
import { recommendedPlanName } from '../state/derived';
import { WhyTrace } from './WhyTrace';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read a string field off the SDK placement content, with token interpolation. */
function field(content: unknown, key: string, tokens: Record<string, string>): string {
  if (!isRecord(content)) return '';
  const raw = content[key];
  return typeof raw === 'string' ? interpolate(raw, tokens) : '';
}

interface NudgeProps {
  placementId: string;
  tokens: Record<string, string>;
  /** Dispatch a CTA action (the playground performs the effect + logs it). */
  onCta: (cta: CtaPath) => void;
  /** Called when the user dismisses the surface (banner/modal/gate). */
  onDismiss?: () => void;
}

/**
 * Renders one SDK placement (resolved by id) as a toast. The SDK owns the copy
 * + which CTA; the playground owns presentation, the personalization tokens, and
 * the CTA effect (sourced from the authored config — see {@link authoredCta}).
 */
function Toast({ placementId, tokens, onCta }: NudgeProps) {
  const { content, visible, ctaClick } = usePlacement({ placement: { name: placementId } });
  if (!visible) return null;
  const label = field(content, 'cta_label', tokens);
  return (
    <div className="prism-nudge prism-nudge--toast" role="status">
      <strong>{field(content, 'header', tokens)}</strong>
      <span>{field(content, 'body', tokens)}</span>
      {label && (
        <button
          className="prism-btn prism-btn--small"
          onClick={() => {
            void ctaClick();
            const cta = authoredCta(PRISM_CONFIG, placementId, 0);
            if (cta) onCta(cta);
          }}
        >
          {label}
        </button>
      )}
      <WhyTrace id={placementId} />
    </div>
  );
}

function Banner({ placementId, tokens, onCta, onDismiss }: NudgeProps) {
  const { content, visible, ctaClick, dismiss } = usePlacement({ placement: { name: placementId } });
  if (!visible) return null;
  const label = field(content, 'cta_label', tokens);
  return (
    <div className="prism-nudge prism-nudge--banner" role="status">
      <div className="prism-nudge__copy">
        <strong>{field(content, 'header', tokens)}</strong>
        <span>{field(content, 'body', tokens)}</span>
        <WhyTrace id={placementId} />
      </div>
      <div className="prism-nudge__actions">
        {label && (
          <button
            className="prism-btn prism-btn--small"
            onClick={() => {
              void ctaClick();
              const cta = authoredCta(PRISM_CONFIG, placementId, 0);
              if (cta) onCta(cta);
            }}
          >
            {label}
          </button>
        )}
        <button
          className="prism-nudge__close"
          aria-label="Dismiss"
          onClick={() => {
            void dismiss();
            onDismiss?.();
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function Modal({ placementId, tokens, onCta, onDismiss }: NudgeProps) {
  const { state } = useDemo();
  const { content, visible, ctaClick, dismiss } = usePlacement({ placement: { name: placementId } });
  // The decision content drops secondary_body + the second CTA, so read them
  // from the authored config to render the modal as designed.
  const authored = useMemo(() => authoredSecondary(PRISM_CONFIG, placementId), [placementId]);
  // Plan recommendation (recommendation_strategy): only for placements that
  // authored one (see RECOMMENDATION_PLACEMENT_IDS).
  const recommendedPlan = RECOMMENDATION_PLACEMENT_IDS.has(placementId)
    ? recommendedPlanName(PRISM_CONFIG, placementId, state.planHandle)
    : null;
  if (!visible) return null;
  const primary = field(content, 'cta_label', tokens);
  const secondary = interpolate(authored.ctaLabel, tokens);
  const secondaryBody = interpolate(authored.body, tokens);
  const close = () => {
    void dismiss();
    onDismiss?.();
  };
  return (
    <div className="prism-modal__overlay" role="dialog" aria-modal="true">
      <div className="prism-modal">
        <h3 className="prism-modal__title">{field(content, 'header', tokens)}</h3>
        <p className="prism-modal__body">{field(content, 'body', tokens)}</p>
        {secondaryBody && <p className="prism-modal__secondary">{secondaryBody}</p>}
        {recommendedPlan && (
          <p className="prism-modal__recommend">
            ✨ We recommend <strong>{recommendedPlan}</strong>
          </p>
        )}
        <WhyTrace id={placementId} />
        <div className="prism-modal__actions">
          {primary && (
            <button
              className="prism-btn prism-btn--primary"
              onClick={() => {
                void ctaClick();
                const cta = authoredCta(PRISM_CONFIG, placementId, 0);
                if (cta) onCta(cta);
              }}
            >
              {primary}
            </button>
          )}
          <button
            className="prism-btn"
            onClick={() => {
              const cta = authoredCta(PRISM_CONFIG, placementId, 1);
              if (cta && cta.type !== 'dismiss') onCta(cta);
              close();
            }}
          >
            {secondary || 'Not now'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Inline({ placementId, tokens, onCta }: NudgeProps) {
  const { content, visible, ctaClick } = usePlacement({ placement: { name: placementId } });
  if (!visible) return null;
  const label = field(content, 'cta_label', tokens);
  return (
    <div className="prism-nudge prism-nudge--inline">
      <span>{field(content, 'body', tokens)}</span>
      {label && (
        <button
          className="prism-link"
          onClick={() => {
            void ctaClick();
            const cta = authoredCta(PRISM_CONFIG, placementId, 0);
            if (cta) onCta(cta);
          }}
        >
          {label}
        </button>
      )}
      <WhyTrace id={placementId} />
    </div>
  );
}

const SURFACE_COMPONENT: Record<NudgeSurface, (props: NudgeProps) => ReactNode> = {
  toast: Toast,
  banner: Banner,
  modal: Modal,
  inline: Inline,
};

export interface NudgesProps {
  /** A click-driven feature-gate modal to show (by placement id), or null. */
  gatePlacementId: string | null;
  onCta: (cta: CtaPath) => void;
  onDismissGate: () => void;
}

/**
 * The Prism stage's nudge host (plan 81 TASK-3/4). Renders the state-driven
 * threshold / qualifier / inline-gate placements computed by {@link activeNudges},
 * plus a click-driven feature-gate modal. Banners + inline gates render inline;
 * toasts stack top-right; at most one modal shows at a time (a click-driven gate
 * takes precedence over the threshold modals). Each surface resolves its
 * placement by id through the SDK and routes CTAs through {@link NudgesProps.onCta}.
 */
export function Nudges({ gatePlacementId, onCta, onDismissGate }: NudgesProps) {
  const { state } = useDemo();
  const nudges = useMemo(() => activeNudges(PRISM_CONFIG, state), [state]);

  const inline = nudges.filter((n) => n.surface === 'inline');
  const banners = nudges.filter((n) => n.surface === 'banner');
  const toasts = nudges.filter((n) => n.surface === 'toast');
  const modals = nudges.filter((n) => n.surface === 'modal');

  const render = (n: ActiveNudge) => {
    const Component = SURFACE_COMPONENT[n.surface];
    return <Component key={n.placementId} placementId={n.placementId} tokens={n.tokens} onCta={onCta} />;
  };

  return (
    <>
      {banners.length > 0 && (
        <div className="prism-nudge-region prism-nudge-region--banners">{banners.map(render)}</div>
      )}
      {inline.length > 0 && (
        <div className="prism-nudge-region prism-nudge-region--inline">{inline.map(render)}</div>
      )}
      {toasts.length > 0 && (
        <div className="prism-nudge-region prism-nudge-region--toasts">{toasts.map(render)}</div>
      )}
      {/* At most one modal at a time: a click-driven gate takes precedence over
          the state-driven threshold modals. */}
      {gatePlacementId ? (
        <Modal placementId={gatePlacementId} tokens={{}} onCta={onCta} onDismiss={onDismissGate} />
      ) : (
        modals[0] && render(modals[0])
      )}
    </>
  );
}
