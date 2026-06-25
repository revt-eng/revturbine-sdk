import { SmartRail } from './SmartRail';
import type { CtaPath } from '../state/cta-actions';

/**
 * Prism's fake app sidebar (plan 83) — the demo product's left rail: app
 * navigation (non-functional), the smart rail (a single bottom-left slot that
 * surfaces the one most-urgent monetization moment), and a Plans & pricing
 * link at the very bottom. Reads as part of the app's own chrome (REQ-4).
 */
const NAV: ReadonlyArray<{ label: string; icon: string; active?: boolean }> = [
  { label: 'Create', icon: '✨', active: true },
  { label: 'Gallery', icon: '▦' },
  { label: 'Projects', icon: '◳' },
  { label: 'Settings', icon: '⚙' },
];

export function AppSidebar({
  onCta,
  onOpenPlans,
}: {
  onCta: (cta: CtaPath) => void;
  onOpenPlans: () => void;
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
        <SmartRail onCta={onCta} />
      </div>

      <button className="prism-app__plans-link" onClick={onOpenPlans}>
        Plans &amp; pricing
      </button>
    </aside>
  );
}
