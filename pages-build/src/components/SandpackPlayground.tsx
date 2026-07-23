import {
  SandpackProvider,
  SandpackCodeEditor,
  SandpackPreview,
} from '@codesandbox/sandpack-react';
import React, { useMemo, useState, useEffect } from 'react';
import type { SandpackScenario } from '../sandpack/scenarios';
import { sandpackScenarios } from '../sandpack/scenarios';
import { demoUsers } from '../sandpack/demoUsers';
import { DEMO_USER_IDS } from '../sandpack/shared';

// Raw string imports for Sandpack virtual filesystem
// @ts-expect-error -- Vite raw import
import exportedConfigRaw from '../sandpack/example-playbook.json?raw';
// @ts-expect-error -- Vite raw import
import demoUsersRaw from '../sandpack/demoUsers.ts?raw';
// @ts-expect-error -- Vite raw import
import sharedRaw from '../sandpack/shared.ts?raw';

// Typed import for host-side inspector usage
import exportedConfigJson from '../sandpack/example-playbook.json';

// Host-side SDK — the PUBLISHED package, not the sibling source tree. The docs
// should demonstrate exactly what a customer installs, so the rendered output and
// the decision inspector on this page run the same artifact readers get from npm.
// (Sibling-source imports also silently drifted ahead of the published SDK.)
import {
  RevTurbineProvider,
  PlacementDecisionInspector,
  useRevTurbine,
  RevTurbineThemeProvider,
  mergeTheme,
  DEFAULT_THEME,
  Slot,
  Gate,
} from '@revturbine/sdk';

/**
 * The inspector's palette, matched to the playground chrome.
 *
 * Scoped deliberately to the inspector: the rendered-output panel keeps the demo
 * config's own theme, because that panel is showing what a customer's placement
 * looks like with their branding — recolouring it would misrepresent the demo.
 * The playground chrome is dark in both site themes, so this is unconditional
 * rather than tied to Starlight's light/dark toggle.
 */
const INSPECTOR_THEME = mergeTheme({
  colors: {
    ...DEFAULT_THEME.colors,
    background: '#0f172a',
    surface: '#1e293b',
    surfaceBorder: '#334155',
    text: '#e2e8f0',
    textSecondary: '#cbd5e1',
    textMuted: '#94a3b8',
  },
});

// Published `@revturbine/sdk` version to install in the Sandpack sandboxes.
// Injected at build time from ../web-sdk/package.json via astro.config.mjs.
const SDK_VERSION = (import.meta.env.PUBLIC_SDK_VERSION as string) ?? '0.2.21';

type SandpackFile = { code: string; active?: boolean; hidden?: boolean };

/**
 * `App.tsx` for every component scenario — byte-identical across all of them.
 *
 * It owns only the one-time wiring a real app does once (provider, demo config,
 * demo user, CTA resolvers) and renders `<Example />`. Because the scenario and
 * the selected demo user both live in other files, switching either one leaves
 * this file untouched, so readers can learn the setup once and then read only
 * `Example.tsx` from example to example.
 */
const APP_TSX = `import React, { useMemo } from "react";
import { RevTurbineProvider } from "@revturbine/sdk";
import playbook from "./playbook.json";
import { demoUsers } from "./demoUsers";
import { selectedUserId } from "./demoUser";
import { Example } from "./Example";

const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export default function App() {
  const options = useMemo(
    () => ({
      localRuntime: { playbook },
      user: activeUser.context,
      uiPathResolvers: {
        navigate_to_plans: async (ctx) => { console.log("[uiPath] navigate_to_plans", ctx); },
        open_checkout_modal: async (ctx) => { console.log("[uiPath] open_checkout_modal", ctx); },
        book_demo: async (ctx) => { console.log("[uiPath] book_demo", ctx); },
        custom_url: async (ctx) => { console.log("[uiPath] custom_url", ctx); },
      },
    }),
    [],
  );

  return (
    <RevTurbineProvider options={options}>
      <Example />
    </RevTurbineProvider>
  );
}
`;

/**
 * `App.tsx` for headless scenarios. The imperative API builds its own session
 * inside the example, so there is no provider to set up — but the shape still
 * matches: boilerplate here, the interesting code in `Example.tsx`.
 */
const HEADLESS_APP_TSX = `import React from "react";
import { Example } from "./Example";

// The headless API creates its own session, so there is no provider to mount —
// all of the interesting code lives in Example.tsx.
export default function App() {
  return <Example />;
}
`;

/** The one file that differs per demo user, so App.tsx never has to. */
const demoUserFile = (selectedUserId: string) =>
  `// Set by the User dropdown above — the playground rewrites this file.
export const selectedUserId = ${JSON.stringify(selectedUserId)};
`;

function buildSandpackFiles(
  scenario: SandpackScenario,
  selectedUserId: string,
): Record<string, SandpackFile> {
  const componentName = scenario.component;
  const templateIdsLiteral = JSON.stringify(scenario.surfaceTemplateIds);
  const isHeadless =
    componentName === 'HeadlessPlacement' ||
    componentName === 'HeadlessEntitlementGate' ||
    componentName === 'HeadlessSession';

  const exampleCode = isHeadless
    ? generateHeadlessExampleCode(scenario, componentName, templateIdsLiteral)
    : generateComponentExampleCode(scenario, componentName, templateIdsLiteral);

  return {
    // The focal file — opened by default so the scenario's code is what a reader
    // lands on, rather than the provider boilerplate they have already seen.
    '/Example.tsx': { code: exampleCode, active: true },
    '/App.tsx': { code: isHeadless ? HEADLESS_APP_TSX : APP_TSX },
    '/demoUser.ts': { code: demoUserFile(selectedUserId) },
    // Fixtures — importable, but not worth a tab.
    '/demoUsers.ts': { code: demoUsersRaw as string, hidden: true },
    '/shared.ts': { code: sharedRaw as string, hidden: true },
    '/playbook.json': { code: exportedConfigRaw as string, hidden: true },
  };
}

/** The scenario's actual slot usage — the code the example exists to show. */
function generateComponentExampleCode(
  scenario: SandpackScenario,
  componentName: string,
  templateIdsLiteral: string,
): string {
  if (componentName === 'Gate') {
    return `import { ${componentName} } from "@revturbine/sdk";

export function Example() {
  return (
    <${componentName}
      id="${scenario.slotId}"
      surfaceTemplateIds={${templateIdsLiteral}}
      check={{ entitlement: "${scenario.entitlementHandle}" }}
    >
      <div style={{ padding: 16, background: "#e8f5e9", borderRadius: 8, border: "1px solid #a5d6a7" }}>
        ✅ Access granted — premium content visible
      </div>
    </${componentName}>
  );
}
`;
  }

  return `import { ${componentName} } from "@revturbine/sdk";

export function Example() {
  return (
    <${componentName}
      id="${scenario.slotId}"
      surfaceTemplateIds={${templateIdsLiteral}}
    />
  );
}
`;
}

/**
 * Headless scenarios, same shape as the component ones: the imperative SDK code
 * lives in `Example.tsx` and exports `Example`, so App.tsx stays boilerplate.
 * The active demo user comes from `./demoUser`, not a baked-in literal.
 */
function generateHeadlessExampleCode(
  scenario: SandpackScenario,
  componentName: string,
  templateIdsLiteral: string,
): string {
  switch (componentName) {
    case 'HeadlessPlacement':
      return `import React, { useEffect, useState, useRef } from "react";
import { initRevTurbine, PlacementController } from "@revturbine/sdk/headless";
import playbook from "./playbook.json";
import { demoUsers } from "./demoUsers";
import { selectedUserId } from "./demoUser";

const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export function Example() {
  const [state, setState] = useState({ isLoading: true, error: "", visible: false, content: null, placementId: "" });
  const ctrlRef = useRef(null);

  useEffect(() => {
    (async () => {
      const session = await initRevTurbine({
        localRuntime: { playbook },
        user: activeUser.context,
        uiPathResolvers: {
          navigate_to_plans: async (ctx) => { console.log("[uiPath] navigate_to_plans", ctx); },
          open_checkout_modal: async (ctx) => { console.log("[uiPath] open_checkout_modal", ctx); },
          custom_url: async (ctx) => { console.log("[uiPath] custom_url", ctx); },
        },
      });

      const ctrl = session.placement({
        slotId: "${scenario.slotId}",
        surfaceTemplateIds: ${templateIdsLiteral},
      });
      ctrlRef.current = ctrl;

      ctrl.subscribe((next) => setState(next));
    })();

    return () => { ctrlRef.current?.dispose?.(); };
  }, []);

  if (state.isLoading) return <p>Loading…</p>;
  if (state.error) return <pre style={{ color: "red" }}>{state.error}</pre>;
  if (!state.visible) return <p>No placement matched.</p>;

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h3>Headless: ${scenario.title}</h3>
      <pre style={{ background: "#f5f5f5", padding: 12, borderRadius: 8, fontSize: 12, overflow: "auto" }}>
        {JSON.stringify(state, null, 2)}
      </pre>
    </div>
  );
}
`;

    case 'HeadlessEntitlementGate':
      return `import React, { useEffect, useState } from "react";
import { initRevTurbine, EntitlementGate } from "@revturbine/sdk/headless";
import playbook from "./playbook.json";
import { demoUsers } from "./demoUsers";
import { selectedUserId } from "./demoUser";

const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export function Example() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const session = await initRevTurbine({
        localRuntime: { playbook },
        user: activeUser.context,
        uiPathResolvers: {},
      });

      const gate = new EntitlementGate(session, {
        entitlementHandle: "${scenario.entitlementHandle}",
        slotId: "${scenario.slotId}",
        surfaceTemplateIds: ${templateIdsLiteral},
      });
      gate.check()
        .then(setResult).catch((e) => setError(e.message));
    })();
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h3>Gate: ${scenario.title}</h3>
      <p>Entitlement: <code>${scenario.entitlementHandle}</code></p>
      {error && <pre style={{ color: "red" }}>{error}</pre>}
      {result && <pre style={{ background: "#f5f5f5", padding: 12, borderRadius: 8, fontSize: 12, overflow: "auto" }}>{JSON.stringify(result, null, 2)}</pre>}
      {!result && !error && <p>Checking…</p>}
    </div>
  );
}
`;

    case 'HeadlessSession':
      return `import React, { useEffect, useState } from "react";
import { initRevTurbine, SdkSession } from "@revturbine/sdk/headless";
import playbook from "./playbook.json";
import { demoUsers } from "./demoUsers";
import { selectedUserId } from "./demoUser";

const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export function Example() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const session = await initRevTurbine({
        localRuntime: { playbook },
        user: activeUser.context,
        uiPathResolvers: {},
      });

      const sdk = new SdkSession(session, {});
      sdk.getPlacement({
        slotId: "${scenario.slotId}",
        surfaceTemplateIds: ${templateIdsLiteral},
      })
        .then(setResult).catch((e) => setError(e.message));
    })();
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h3>Session: ${scenario.title}</h3>
      {error && <pre style={{ color: "red" }}>{error}</pre>}
      {result && <pre style={{ background: "#f5f5f5", padding: 12, borderRadius: 8, fontSize: 12, overflow: "auto" }}>{JSON.stringify(result, null, 2)}</pre>}
      {!result && !error && <p>Resolving…</p>}
    </div>
  );
}
`;

    default:
      return '// Unknown headless type';
  }
}

export interface SandpackPlaygroundProps {
  scenarioId: string;
}

/**
 * CSS for the 3-panel playground layout + inspector isolation.
 * Uses a scoped class to avoid leaking into the rest of Starlight.
 */
const playgroundCSS = `
/* ── Full-width override — expand Starlight content column ──────────── */
.sl-container:has(.rt-playground) {
  max-width: none !important;
}

/* ── 3-panel layout: preview + inspector on top, editor below ──────── */
.rt-playground {
  border: 1px solid var(--rt-border);
  border-radius: 10px;
  overflow: hidden;
  --rt-border: #334155;
  --rt-surface: #1e293b;
  --rt-surface-alt: #0f172a;
  --rt-text: #e2e8f0;
  --rt-text-muted: #94a3b8;
  font-family: ui-sans-serif, system-ui, sans-serif;
}
/* SandpackProvider renders a wrapper div — make it the playground grid.
 *
 * Left column stacks preview over editor; the inspector takes the right column
 * across BOTH rows. The three panels have very different appetites: the preview
 * renders one small component (a button, a banner), the editor holds ~20 short
 * lines, and the inspector is the dense one — decision summary, user context,
 * raw JSON. The old layout gave preview and inspector an identical 520px row
 * and then handed the editor the full width, so the preview was mostly empty,
 * the inspector scrolled inside its half, and the editor wasted its right side.
 * Spanning the inspector fixes all three and drops the widget from 1018px to
 * ~700px — worth a lot on a page that stacks seven of them.
 */
.rt-playground > .sp-wrapper {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-rows: 300px 400px; /* preview, editor */
}

/* Top-left: rendered output */
.rt-panel-preview {
  position: relative;
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--rt-border);
  border-bottom: 1px solid var(--rt-border);
}

/* ── Shared panel header ─────────────────────────────────────────────────
 * Both top panels wear the SAME fixed-height header, so their titles and
 * controls sit on one line across the widget. Previously only the inspector had
 * one, and it was a two-line title-plus-meta block whose height changed with its
 * content — so it read as a banner floating beside a header-less preview.
 */
.rt-panel-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 40px;
  padding: 0 12px;
  background: var(--rt-surface);
  border-bottom: 1px solid var(--rt-border);
}
.rt-panel-header-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--rt-text-muted);
  white-space: nowrap;
}
.rt-panel-body {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
}

/* The rendered example itself — centred, with room to breathe. */
.rt-output-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--rt-surface-alt);
}
.rt-sandbox-body {
  padding: 0;
  background: var(--rt-surface-alt);
  overflow: hidden;
}
.rt-output-note {
  max-width: 38ch;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--rt-text-muted);
}
.rt-output-granted {
  padding: 16px;
  background: #e8f5e9;
  border: 1px solid #a5d6a7;
  border-radius: 8px;
  color: #14532d;
  font-size: 13px;
}
.rt-open-sandbox-btn {
  flex: 0 0 auto;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--rt-text);
  background: transparent;
  border: 1px solid var(--rt-border);
  border-radius: 6px;
  cursor: pointer;
}
.rt-open-sandbox-btn:hover {
  background: #334155;
}
.rt-open-sandbox-btn:focus-visible {
  outline: 2px solid #6366f1;
  outline-offset: 1px;
}
/* When the sandbox takes over, its preview fills the body. */
.rt-panel-preview .sp-preview-container,
.rt-panel-preview .sp-preview-iframe {
  height: 100% !important;
  min-height: 0 !important;
}

/* Bottom-left: code editor — beside the inspector, not under it */
.rt-panel-editor {
  grid-column: 1;
  grid-row: 2;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--rt-border);
}
.rt-panel-editor .sp-editor,
.rt-panel-editor .sp-stack {
  flex: 1 1 0 !important;
  height: 100% !important;
  min-height: 0 !important;
}
.rt-panel-editor .sp-code-editor {
  flex: 1 1 0 !important;
  overflow: auto !important;
  min-height: 0 !important;
}

/* ── Inspector panel (right column, full height) ─────────────────────── */
.rt-inspector-wrap {
  grid-column: 2;
  grid-row: 1 / -1; /* span preview + editor rows — this is the dense panel */
  display: flex;
  flex-direction: column;
  background: var(--rt-surface-alt);
  overflow: hidden;
  height: 100%;
  min-width: 0;
}
/* The SDK component ships its own header — title, slot/user meta, and a Refresh
 * button. The panel header above already gives the title and the user control,
 * so hide only the DUPLICATED title block and keep Refresh. The previous rule
 * hid the whole header element, which silently took Refresh with it; it was also a
 * direct-child selector that would stop matching if the card were ever wrapped. */
.rt-inspector-iso section[data-rt-inspector] > header > div:first-child {
  display: none !important;
}
.rt-inspector-iso section[data-rt-inspector] > header {
  justify-content: flex-end !important;
  margin-bottom: 4px;
}
.rt-inspector-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rt-inspector-controls label {
  font-size: 12px;
  color: var(--rt-text-muted);
}
.rt-user-select {
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--rt-border);
  background: var(--rt-surface);
  color: var(--rt-text);
  font-size: 12px;
  cursor: pointer;
}
.rt-user-select:focus {
  outline: 2px solid #6366f1;
  outline-offset: 1px;
}
/* Match the output panel's padding so the two bodies line up, and let the card
 * fill the panel instead of floating in a wide dark gutter. */
.rt-inspector-body {
  padding: 12px;
}
.rt-inspector-body > section[data-rt-inspector] {
  margin: 0;
}

/* ── Narrow viewports ────────────────────────────────────────────────────
 * Starlight's content column tracks the viewport, so below roughly this width
 * two columns leave the editor too narrow for its code and the inspector too
 * narrow for placement ids and raw JSON. Stack instead: preview, inspector,
 * editor — each full width. Rows are assigned explicitly, so this does not
 * depend on DOM order.
 */
@media (max-width: 1200px) {
  .rt-playground > .sp-wrapper {
    grid-template-columns: minmax(0, 1fr);
    /* The inspector's content is ~1100px tall almost regardless of width — extra
       width barely compresses it — so it always scrolls. Give it a row tall
       enough to show the decision summary AND the user context together, which
       is the part worth reading; a shorter row here was strictly worse than the
       two-column layout it replaces. */
    grid-template-rows: 280px 520px 380px;
  }
  .rt-panel-preview {
    grid-column: 1;
    grid-row: 1;
    border-right: none;
  }
  .rt-inspector-wrap {
    grid-column: 1;
    grid-row: 2;
    border-bottom: 1px solid var(--rt-border);
  }
  .rt-panel-editor {
    grid-column: 1;
    grid-row: 3;
    border-right: none;
  }
}

/* ── Inspector element neutralisation ────────────────────────────────────
 * The inspector paints itself from the SDK theme now (see INSPECTOR_THEME), so
 * this no longer forces a light palette — it only neutralises Starlight's
 * GLOBAL element styling for the few tags the SDK does not style inline
 * (code chips, summary markers). Everything inherits its colour from the
 * themed card, so it follows whatever theme the inspector is given.
 */
.rt-inspector-iso code {
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: inherit;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
  border: none;
}
.rt-inspector-iso pre code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
}
.rt-inspector-iso h3,
.rt-inspector-iso h4 {
  border: none;
  margin-top: 0;
}
.rt-inspector-iso summary {
  cursor: pointer;
}

`;

function isHeadlessScenario(component: string) {
  return (
    component === 'HeadlessPlacement' ||
    component === 'HeadlessEntitlementGate' ||
    component === 'HeadlessSession'
  );
}

/**
 * The example, actually rendered — host-side, with the published SDK.
 *
 * This is what the preview panel shows by default. It is the real component
 * resolving a real decision against the demo config, so it needs no bundler,
 * appears instantly, and cannot show a crashed frame. Sandpack is now reserved
 * for readers who want to *edit* the example (see `SandboxPane`).
 */
function LiveOutput({ scenario }: { scenario: SandpackScenario }) {
  const { isReady } = useRevTurbine();

  if (!isReady) {
    return <div className="rt-output-note">Resolving decision…</div>;
  }

  // Headless examples drive the imperative API and have no rendered component —
  // say so rather than inventing output that the example does not produce.
  if (isHeadlessScenario(scenario.component)) {
    return (
      <div className="rt-output-note">
        This example uses the imperative headless API, so it has no rendered
        component. The resolved decision is on the right — open it in Sandpack to
        run the code.
      </div>
    );
  }

  if (scenario.component === 'Gate') {
    return (
      <Gate
        id={scenario.slotId}
        surfaceTemplateIds={scenario.surfaceTemplateIds}
        check={{ entitlement: scenario.entitlementHandle as string }}
      >
        <div className="rt-output-granted">✅ Access granted — premium content visible</div>
      </Gate>
    );
  }

  return <Slot id={scenario.slotId} surfaceTemplateIds={scenario.surfaceTemplateIds} />;
}

/**
 * The editable sandbox, mounted only once the reader asks for it.
 *
 * Mounting is the trigger: with no `SandpackPreview` on the page there is no
 * client, so nothing bundles until this renders — and once it does, Sandpack's
 * default autorun starts it. Leaving `autorun: false` on instead would have put
 * a Run button in the code editor that did nothing visible, because the panel
 * beside it shows the host-side output rather than the sandbox.
 */
function SandboxPane() {
  return <SandpackPreview />;
}

/** Opens the editable sandbox. Separate so it can reach Sandpack's context. */
function OpenInSandpackButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="rt-open-sandbox-btn" onClick={onOpen}>
      Open in Sandpack
    </button>
  );
}

/**
 * Both live panels, sharing ONE SDK session.
 *
 * The rendered output and the decision inspector previously could not have
 * disagreed only by luck — they now read the same session, so what the reader
 * sees rendered is provably the decision the inspector explains. Returns a
 * fragment: RevTurbineProvider emits no DOM, so both panels stay direct grid
 * children of the playground wrapper.
 */
function PlaygroundPanels({
  scenario,
  selectedUserId,
  onUserChange,
  sandboxOpen,
  onOpenSandbox,
}: {
  scenario: SandpackScenario;
  selectedUserId: string;
  onUserChange: (userId: string) => void;
  sandboxOpen: boolean;
  onOpenSandbox: () => void;
}) {
  const { sdk, isReady } = useRevTurbine();
  const selectedUser = demoUsers[selectedUserId] ?? demoUsers[scenario.demoUserId];
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!sdk || !isReady) return;
    sdk.resetIdentity();
    sdk.setUserContext(selectedUser.context);
    setRevision((r) => r + 1);
  }, [sdk, isReady, selectedUser]);

  return (
    <>
      {/* Top-left — the example, rendered for real */}
      <div className="rt-panel-preview">
        <div className="rt-panel-header">
          <p className="rt-panel-header-title">
            {sandboxOpen ? 'Sandbox' : 'Rendered output'}
          </p>
          {!sandboxOpen && <OpenInSandpackButton onOpen={onOpenSandbox} />}
        </div>
        {/* The centring/padding is for a small rendered component; the sandbox
            iframe should fill the panel edge to edge instead. */}
        <div className={`rt-panel-body ${sandboxOpen ? 'rt-sandbox-body' : 'rt-output-body'}`}>
          {sandboxOpen ? (
            <SandboxPane />
          ) : (
            <LiveOutput key={`${scenario.id}:${selectedUserId}:${revision}`} scenario={scenario} />
          )}
        </div>
      </div>

      {/* Top-right — why that output happened */}
      <div className="rt-inspector-wrap">
        <div className="rt-panel-header">
          <p className="rt-panel-header-title">Decision inspector</p>
          <div className="rt-inspector-controls">
            <label htmlFor={`rt-user-${scenario.id}`}>User</label>
            <select
              id={`rt-user-${scenario.id}`}
              className="rt-user-select"
              value={selectedUserId}
              onChange={(e) => onUserChange(e.target.value)}
            >
              {DEMO_USER_IDS.map((id) => (
                <option key={id} value={id}>
                  {demoUsers[id].label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="rt-panel-body rt-inspector-body rt-inspector-iso">
          {isReady ? (
            <RevTurbineThemeProvider theme={INSPECTOR_THEME}>
              <PlacementDecisionInspector
                key={`${scenario.id}:${selectedUserId}:${revision}`}
                surfaceSlot={{
                  id: scenario.slotId,
                  surfaceTemplateIds: scenario.surfaceTemplateIds,
                }}
                userId={selectedUser.context.id}
                showRawJson
              />
            </RevTurbineThemeProvider>
          ) : (
            <div className="rt-output-note">Preparing decision inspector…</div>
          )}
        </div>
      </div>
    </>
  );
}

/** Host-side SDK session shared by the output and the inspector. */
function PlaygroundRuntime(props: {
  scenario: SandpackScenario;
  selectedUserId: string;
  onUserChange: (userId: string) => void;
  sandboxOpen: boolean;
  onOpenSandbox: () => void;
}) {
  const options = useMemo(
    () => ({
      localRuntime: { playbook: exportedConfigJson },
      uiPathResolvers: {
        navigate_to_plans: async () => {},
        open_upgrade_modal: async () => {},
        open_checkout_modal: async () => {},
        open_feature_tour: async () => {},
        book_demo: async () => {},
        custom_url: async () => {},
        contact_sales: async () => {},
        manage_subscription: async () => {},
      },
    }),
    [],
  );

  return (
    <RevTurbineProvider options={options}>
      <PlaygroundPanels {...props} />
    </RevTurbineProvider>
  );
}


export default function SandpackPlayground({ scenarioId }: SandpackPlaygroundProps) {
  const scenario = sandpackScenarios.find((s) => s.id === scenarioId);
  const [selectedUserId, setSelectedUserId] = useState(scenario?.demoUserId ?? 'user_alice');
  // Sandpack now mounts only on request, so a page full of examples costs no
  // bundlers at all until a reader actually wants to edit one.
  const [sandboxOpen, setSandboxOpen] = useState(false);

  if (!scenario) {
    return (
      <div style={{ padding: 16, color: 'red', fontFamily: 'system-ui' }}>
        Unknown scenario: <code>{scenarioId}</code>
      </div>
    );
  }

  const files = useMemo(() => buildSandpackFiles(scenario, selectedUserId), [scenario, selectedUserId]);

  return (
    // `not-content` opts the whole widget out of Starlight's prose styling.
    // Without it Starlight's "adjacent siblings get margin-top: 1rem" rule lands
    // on the grid items themselves: the inspector was pushed 16px below the
    // preview it is supposed to sit level with, and the editor lost 16px of its
    // row. That is the misaligned banner, not anything in this component's CSS.
    <div className="rt-playground not-content">
      <style dangerouslySetInnerHTML={{ __html: playgroundCSS }} />
      <SandpackProvider
        template="react-ts"
        // Follow the site's light/dark setting, matching CodeExample. Without
        // this Sandpack defaults to its light theme, so on a dark docs page the
        // preview and editor rendered as white panels inside the playground's
        // dark chrome.
        theme="auto"
        key={`${scenario.id}:${selectedUserId}`}
        files={files}
        customSetup={{
          dependencies: {
            '@revturbine/sdk': SDK_VERSION,
            react: '^18',
            'react-dom': '^18',
          },
        }}
        options={{
          recompileMode: 'delayed',
          recompileDelay: 250,
          // Every SandpackProvider is its own iframe running its own bundler —
          // there is no shared-bundler mode. A guide page that stacks the whole
          // scenario gallery (the Placements guide mounts seven of these plus
          // three inline CodeExamples) therefore boots ~10 bundlers at once,
          // which is enough to OOM individual frames: readers see Chrome's
          // crashed-frame icon in every preview.
          //
          // Belt and braces: SandpackPreview is not mounted until the reader
          // presses "Open in Sandpack", so nothing bundles on load regardless.
          // `user-visible` also keeps the code editor from initialising until
          // the widget is actually scrolled to.
          initMode: 'user-visible',
        }}
      >
        {/* Rendered output + decision inspector, sharing one host-side session */}
        <PlaygroundRuntime
          scenario={scenario}
          selectedUserId={selectedUserId}
          onUserChange={setSelectedUserId}
          sandboxOpen={sandboxOpen}
          onOpenSandbox={() => setSandboxOpen(true)}
        />

        {/* Bottom — code editor (full width) */}
        <div className="rt-panel-editor">
          {/* Wrap rather than scroll: the generated App.tsx wants ~750px for its
              longest line, but the playground only ever gets about half the
              viewport, so an unwrapped editor scrolls sideways at every
              realistic width. */}
          <SandpackCodeEditor showLineNumbers showTabs wrapContent />
        </div>
      </SandpackProvider>
    </div>
  );
}
