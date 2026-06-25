import { useEntitlement, useRevTurbine } from '../../index';
import { useStudio } from '../state/StudioProvider';
import { useDemo } from '../state/DemoProvider';
import { PRISM_CONFIG } from '../config/prism-config';
import { overagePriceFor } from '../state/derived';
import type { GenerateOutcome } from '../state/image-engine';
import { ImageCanvas } from './ImageCanvas';

export interface ImageStudioProps {
  /** Surface a short status line (wired to the activity feed). */
  onStatus?: (label: string) => void;
  /** A locked feature was attempted — kind + entitlement handle (TASK-4 opens the gate modal). */
  onGate?: (kind: 'hard' | 'soft', handle: string) => void;
}

/**
 * The Prism studio: the "button clicker" UI + output gallery. Demonstrates the
 * usage-limit (Generate), credits (Premium style), rate-limit, and
 * capability-tier (watermark) feature types. It also showcases the advertised
 * SDK verbs: `useEntitlement` (the React form of `can`) drives the lock UI, the
 * imperative `gate(action, fn)` decides the gated action, and `track()` emits
 * an event on a successful generate.
 */
export function ImageStudio({ onStatus, onGate }: ImageStudioProps) {
  const studio = useStudio();
  const { state } = useDemo();
  const { sdk } = useRevTurbine();
  // Overage pricing (price_per_unit entitlement): plans that allow overage carry
  // a per-image price; Free hard-blocks and has none.
  const overage = overagePriceFor(PRISM_CONFIG, state.planHandle);
  // Only flag overage once usage has actually passed the included limit —
  // before that, no per-image charges apply, so showing the price is misleading.
  const inOverage = !!overage && studio.generationsUsed > studio.generationsLimit;
  const batchExport = useEntitlement({ handle: 'batch_export' });
  const stylePacks = useEntitlement({ handle: 'style_packs' });
  const resolution = useEntitlement({ handle: 'resolution_tier' });
  // Drive the watermark off the resolved capability tier, not the plan handle —
  // so a reverse trial (which grants the Clean-4K tier on the Free plan) removes
  // the watermark too (plan 82).
  const watermarked = (resolution.result?.current_tier ?? 'Watermarked').includes('Watermark');
  const remaining = Math.max(0, studio.generationsLimit - studio.generationsUsed);

  const report = (outcome: GenerateOutcome) => {
    if (outcome.ok) {
      onStatus?.(outcome.image.premium ? 'Generated · premium style (−1 credit)' : 'Generated image');
      return;
    }
    // Every blocked generate opens its gate modal imperatively — the smart-rail
    // card is an ambient warning, not the blocking moment when the click fails.
    if (outcome.reason === 'rate_limited') {
      onStatus?.('Rate limit — slow down a moment');
      onGate?.('hard', 'burst_rate');
    } else if (outcome.reason === 'usage_exhausted') {
      onStatus?.('Out of generations this month');
      onGate?.('hard', 'generations');
    } else {
      onStatus?.('Out of style credits');
      onGate?.('hard', 'credits');
    }
  };

  const generate = () => {
    const outcome = studio.generate();
    report(outcome);
    if (outcome.ok) void sdk?.track('image_generated', { premium: false });
  };

  // gate() decides the gated action: run it when entitled, otherwise surface the
  // paywall. useEntitlement (above) still drives the lock icon — the spec's split
  // of `can` (UI state) vs `gate` (action).
  const attemptPremium = async () => {
    if (!sdk) return onGate?.('soft', 'style_packs');
    const gated = await sdk.gate('style_packs', () => studio.generate({ premium: true }));
    if (gated.ran) {
      report(gated.result);
      void sdk.track('image_generated', { premium: true });
      return;
    }
    // style_packs isn't entitled on this plan (Free), but the plan grants a
    // starter pool of style credits to *try* premium styles. Let them spend a
    // credit until the pool runs dry — then the credit-out gate upsells.
    if (studio.creditBalance > 0) {
      const outcome = studio.generate({ premium: true });
      report(outcome);
      if (outcome.ok) void sdk.track('image_generated', { premium: true });
    } else {
      onGate?.('hard', 'credits');
    }
  };

  const attemptBatchExport = async () => {
    if (!sdk) return onGate?.('hard', 'batch_export');
    const gated = await sdk.gate('batch_export', () => onStatus?.('Exported all images'));
    if (!gated.ran) onGate?.('hard', 'batch_export');
  };

  return (
    <section className="prism-studio">
      <div className="prism-studio__toolbar">
        <button className="prism-btn prism-btn--primary" onClick={generate}>
          ✨ Generate
        </button>
        {/* A badge means "there's a barrier" — shown only when the feature is
            actually gated, so Premium style and Batch export read the same way.
            While Premium style is usable (credits remain) it carries no badge;
            the per-use cost is shown by the live credit counter that ticks down.
            At zero credits it gates: a Free user needs to upgrade ("Pro"), a
            paid user just needs more credits ("Top up"). Enterprise is unlimited
            so it never gates. */}
        <button className="prism-btn" onClick={() => void attemptPremium()}>
          Premium style
          {studio.creditBalance <= 0 && (
            <span className="prism-btn__badge prism-btn__badge--plan">
              {stylePacks.denied ? 'Pro' : 'Top up'}
            </span>
          )}
        </button>
        <button className="prism-btn" onClick={() => void attemptBatchExport()}>
          Batch export
          {batchExport.denied && <span className="prism-btn__badge prism-btn__badge--plan">Pro</span>}
        </button>
      </div>

      <div className="prism-studio__meta">
        <span>
          <strong>{remaining}</strong> / {studio.generationsLimit} generations
        </span>
        <span>
          <strong>{studio.creditBalance}</strong> credits
        </span>
        {inOverage && overage && (
          <span className="prism-studio__overage">
            In overage · ${(overage.amountCents / 100).toFixed(2)}/{overage.unit}
          </span>
        )}
        {watermarked && <span className="prism-studio__tier">Watermarked · 720p</span>}
      </div>

      <ImageCanvas
        images={studio.gallery}
        watermarked={watermarked}
        totalGenerated={studio.generationsUsed}
      />
    </section>
  );
}
