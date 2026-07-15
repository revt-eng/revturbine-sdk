import { sandpackScenarios, type SandpackScenarioGroup } from '../sandpack/scenarios';

const groupOrder: SandpackScenarioGroup[] = [
  'Fixed Slots',
  'Access Gates',
  'Global Slots',
  'Headless API',
];

const groupDescriptions: Record<SandpackScenarioGroup, string> = {
  'Fixed Slots': 'Always-visible inline placements — buttons, cards, meters, banners.',
  'Access Gates': 'Entitlement gates that show upgrade prompts when access is denied.',
  'Global Slots': 'Page-level overlays — toasts, modals, and banners triggered by targeting rules.',
  'Headless API': 'Imperative SDK usage without React components — PlacementController, EntitlementGate, SdkSession.',
};

const groupSlugs: Record<SandpackScenarioGroup, string> = {
  'Fixed Slots': 'fixed-slots',
  'Access Gates': 'access-gates',
  'Global Slots': 'global-slots',
  'Headless API': 'headless',
};

export default function ScenarioIndex() {
  // This component renders client-only, so the build-time rehype plugin that
  // base-prefixes authored links never touches these hrefs. Prefix the base
  // ('' at root, '/docs' when mounted under revturbine.com/docs) ourselves.
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {groupOrder.map((group) => {
        const scenarios = sandpackScenarios.filter((s) => s.group === group);
        const groupSlug = groupSlugs[group];

        return (
          <section key={group}>
            <h3 style={{ marginBottom: 4 }}>{group}</h3>
            <p style={{ color: 'var(--sl-color-gray-3)', fontSize: 14, marginBottom: 12 }}>
              {groupDescriptions[group]}
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 12,
              }}
            >
              {scenarios.map((s) => (
                <a
                  key={s.id}
                  href={`${base}/playground/${groupSlug}/${s.id}/`}
                  style={{
                    display: 'block',
                    padding: '12px 16px',
                    borderRadius: 8,
                    border: '1px solid var(--sl-color-gray-5)',
                    textDecoration: 'none',
                    color: 'inherit',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <div style={{ fontSize: 12, color: 'var(--sl-color-gray-3)', marginBottom: 4 }}>
                    {s.code}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{s.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--sl-color-gray-3)', marginTop: 4 }}>
                    {s.component}
                  </div>
                </a>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
