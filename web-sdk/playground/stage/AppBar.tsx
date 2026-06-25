import { SlotHost } from '../shared/SlotHost';
import type { PlacementUiPath } from '../../placements/types';
import type { PrismPlanHandle } from '../state/demo-state';

/**
 * Prism's own app bar (plan 83) — the demo product's top chrome, distinct from
 * the User Context drawer. Brand + the plan badge + the persistent
 * `header_upgrade_cta` fixed placement (where a real app puts its upgrade
 * button). The app's section nav and the Plans & pricing link live in the
 * sidebar, so the bar stays minimal.
 */
export function AppBar({
  planHandle,
  onSlotCta,
}: {
  planHandle: PrismPlanHandle;
  onSlotCta: (label: string, uiPath: PlacementUiPath) => void;
}) {
  return (
    <header className="prism-app__bar">
      <div className="prism-app__brand">
        <span className="prism-app__logo" aria-hidden>
          ◆
        </span>
        Prism
      </div>
      <div className="prism-app__bar-right">
        <span className={`prism-app__plan prism-app__plan--${planHandle}`}>{planHandle}</span>
        <SlotHost
          id="header_upgrade_cta"
          category="fixed"
          surfaceTemplateIds={['button']}
          onCta={onSlotCta}
          showTrace={false}
          fallback={null}
        />
      </div>
    </header>
  );
}
