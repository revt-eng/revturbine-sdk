import { SlotHost } from '../shared/SlotHost';
import type { PlacementUiPath } from '../../placements/types';

/**
 * Prism's fake app sidebar (plan 83) — the demo product's left rail: app
 * navigation (non-functional) plus the usage rail where the SDK surfaces live
 * naturally. The generations quota meter, the credit counter, and the
 * contextual upsell card all render here, so they read as part of the app's
 * own chrome rather than a demo panel (REQ-4).
 */
const NAV: ReadonlyArray<{ label: string; icon: string; active?: boolean }> = [
  { label: 'Create', icon: '✨', active: true },
  { label: 'Gallery', icon: '▦' },
  { label: 'Projects', icon: '◳' },
  { label: 'Settings', icon: '⚙' },
];

export function AppSidebar({
  onSlotCta,
}: {
  onSlotCta: (label: string, uiPath: PlacementUiPath) => void;
}) {
  return (
    <aside className="prism-app__sidebar" aria-label="Prism navigation">
      <nav className="prism-app__sidenav">
        {NAV.map((n) => (
          <a key={n.label} className={n.active ? 'is-active' : undefined}>
            <span className="prism-app__sidenav-icon" aria-hidden>
              {n.icon}
            </span>
            {n.label}
          </a>
        ))}
      </nav>

      <div className="prism-app__rail">
        <SlotHost
          id="quota_meter"
          category="fixed"
          surfaceTemplateIds={['quota_meter', 'usage_counter']}
          onCta={onSlotCta}
          fallback={<span className="prism__muted">No usage meter.</span>}
        />
        <SlotHost
          id="credit_counter"
          category="fixed"
          surfaceTemplateIds={['credit_balance_counter']}
          onCta={onSlotCta}
          fallback={<span className="prism__muted">No credit counter.</span>}
        />
        <SlotHost
          id="sidebar"
          category="fixed"
          surfaceTemplateIds={['in_page_card']}
          onCta={onSlotCta}
          fallback={null}
        />
      </div>
    </aside>
  );
}
