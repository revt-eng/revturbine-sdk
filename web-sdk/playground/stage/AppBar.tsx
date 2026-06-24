import { SlotHost } from '../shared/SlotHost';
import type { PlacementUiPath } from '../../placements/types';
import type { PrismPlanHandle } from '../state/demo-state';

/**
 * Prism's own app bar (plan 83) — the demo product's top chrome, distinct from
 * the Director. Brand + fake nav + account/plan, and the persistent
 * `header_upgrade_cta` fixed placement lives here (where a real app would put an
 * upgrade button), so the placement reads as part of the product.
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
      <nav className="prism-app__topnav" aria-label="Prism">
        <a className="is-active">Create</a>
        <a>Gallery</a>
        <a>Docs</a>
      </nav>
      <div className="prism-app__bar-right">
        <SlotHost
          id="header_upgrade_cta"
          category="fixed"
          surfaceTemplateIds={['button']}
          onCta={onSlotCta}
          showTrace={false}
          fallback={null}
        />
        <span className={`prism-app__plan prism-app__plan--${planHandle}`}>{planHandle}</span>
        <span className="prism-app__avatar" aria-hidden>
          ◐
        </span>
      </div>
    </header>
  );
}
