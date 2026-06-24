import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { RTSlot } from '../../index';
import type { PlacementUiPath } from '../../placements/types';
import { useDemo } from '../state/DemoProvider';
import { describeCta } from './cta-dispatch';
import { WhyTrace } from '../stage/WhyTrace';

/** Surface-slot render category (matches the SDK's `RTSlot`). */
export type SlotCategory = 'fixed' | 'gated' | 'triggered';

export interface SlotHostProps {
  /** Slot id — must match a placement trigger's `slot_id` in the Prism config. */
  id: string;
  category?: SlotCategory;
  /** Surface template ids this slot accepts (constrains which payload renders). */
  surfaceTemplateIds?: string[];
  /** Called with a human label + the resolved CTA when a placement CTA is clicked. */
  onCta?: (label: string, uiPath: PlacementUiPath) => void;
  /** Show the "why am I seeing this?" decision trace below the slot (default true). */
  showTrace?: boolean;
  className?: string;
  style?: CSSProperties;
  fallback?: ReactNode;
}

/**
 * Thin wrapper around the SDK's advertised `<RTSlot>` (the spec's name for
 * `SurfaceSlotComponent`) that injects the shared personalization tokens from
 * the playground demo state and routes CTA clicks through {@link describeCta}.
 * Every instrumented region on the Prism stage renders through one of these.
 */
export function SlotHost({
  id,
  category = 'fixed',
  surfaceTemplateIds,
  onCta,
  showTrace = true,
  className,
  style,
  fallback,
}: SlotHostProps) {
  const { state } = useDemo();
  const personalization = useMemo(
    () => ({ user_name: 'there', plan_name: state.planHandle }),
    [state.planHandle],
  );

  return (
    <>
      <RTSlot
        id={id}
        category={category}
        surfaceTemplateIds={surfaceTemplateIds}
        personalization={personalization}
        onCtaClick={(uiPath) => onCta?.(describeCta(uiPath), uiPath)}
        className={className}
        style={style}
        fallback={fallback}
      />
      {showTrace && <WhyTrace id={id} />}
    </>
  );
}
