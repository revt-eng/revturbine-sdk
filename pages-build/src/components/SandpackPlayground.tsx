import {
  SandpackProvider,
  SandpackCodeEditor,
  SandpackPreview,
  RunButton,
  useSandpack,
} from '@codesandbox/sandpack-react';
import React, { useMemo, useState, useEffect } from 'react';
import type { SandpackScenario } from '../sandpack/scenarios';
import { sandpackScenarios } from '../sandpack/scenarios';
import { demoUsers } from '../sandpack/demoUsers';
import { DEMO_USER_IDS } from '../sandpack/shared';

// Raw string imports for Sandpack virtual filesystem
// @ts-expect-error -- Vite raw import
import exportedConfigRaw from '../sandpack/example-exported_config.json?raw';
// @ts-expect-error -- Vite raw import
import demoUsersRaw from '../sandpack/demoUsers.ts?raw';
// @ts-expect-error -- Vite raw import
import sharedRaw from '../sandpack/shared.ts?raw';

// Typed import for host-side inspector usage
import exportedConfigJson from '../sandpack/example-exported_config.json';

// Host-side SDK imports — rendered outside Sandpack's iframe for decision inspection
import { RevTurbineProvider } from '../../../web-sdk/react/RevTurbineProvider';
import { PlacementDecisionInspector } from '../../../web-sdk/react/PlacementDecisionInspector';
import { useRevTurbine } from '../../../web-sdk/react/useRevTurbine';

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
import exportedConfig from "./exported_config.json";
import { demoUsers } from "./demoUsers";
import { selectedUserId } from "./demoUser";
import { Example } from "./Example";

const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export default function App() {
  const options = useMemo(
    () => ({
      localRuntime: { exportedConfig },
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
    '/exported_config.json': { code: exportedConfigRaw as string, hidden: true },
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
import exportedConfig from "./exported_config.json";
import { demoUsers } from "./demoUsers";
import { selectedUserId } from "./demoUser";

const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export function Example() {
  const [state, setState] = useState({ isLoading: true, error: "", visible: false, content: null, placementId: "" });
  const ctrlRef = useRef(null);

  useEffect(() => {
    (async () => {
      const session = await initRevTurbine({
        localRuntime: { exportedConfig },
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
import exportedConfig from "./exported_config.json";
import { demoUsers } from "./demoUsers";
import { selectedUserId } from "./demoUser";

const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export function Example() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const session = await initRevTurbine({
        localRuntime: { exportedConfig },
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
import exportedConfig from "./exported_config.json";
import { demoUsers } from "./demoUsers";
import { selectedUserId } from "./demoUser";

const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export function Example() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const session = await initRevTurbine({
        localRuntime: { exportedConfig },
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

/* Top-left: preview */
.rt-panel-preview {
  position: relative; /* positioning context for .rt-run-overlay */
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  border-right: 1px solid var(--rt-border);
  border-bottom: 1px solid var(--rt-border);
}

/* ── Dormant-preview overlay (autorun: false) ───────────────────────── */
.rt-run-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  background: var(--rt-surface-alt);
  color: var(--rt-text);
}
.rt-run-overlay-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.rt-run-overlay-body {
  margin: 0;
  max-width: 34ch;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--rt-text-muted);
}
/* Sandpack's RunButton is absolutely positioned for its in-editor corner slot;
   inside the overlay it needs to sit in normal flow. */
.rt-run-overlay button {
  position: static !important;
  margin-top: 4px;
}
/* Sandpack's own "Open Sandbox" action floats above the overlay and gets clipped
   by the panel edge. Hide it while the sandbox is dormant — it reappears with
   the preview once the reader presses Run. */
.rt-panel-preview:has(.rt-run-overlay) .sp-preview-actions {
  display: none;
}
/* Must not carry a min-height taller than its grid row, or the iframe overflows
   the panel it is supposed to sit inside. */
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
/* Hide the inner inspector header — the outer wrapper already has one */
.rt-inspector-iso > section[data-rt-inspector] > header {
  display: none !important;
}
.rt-inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  background: var(--rt-surface);
  border-bottom: 1px solid var(--rt-border);
  flex-wrap: wrap;
}
.rt-inspector-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--rt-text);
  margin: 0;
}
.rt-inspector-meta {
  font-size: 12px;
  color: var(--rt-text-muted);
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
.rt-inspector-body {
  padding: 16px;
  flex: 1 1 0;
  overflow-y: auto;
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

/* ── Inspector element isolation (prevents Starlight dark-mode bleed) ── */
.rt-inspector-iso,
.rt-inspector-iso *:not(pre) {
  color: inherit;
}
.rt-inspector-iso code {
  background: #f1f5f9 !important;
  color: #0f172a !important;
  padding: 1px 5px !important;
  border-radius: 4px !important;
  font-size: 0.9em !important;
  border: none !important;
}
.rt-inspector-iso pre {
  background: #0f172a !important;
  color: #e2e8f0 !important;
}
.rt-inspector-iso pre code {
  background: transparent !important;
  color: inherit !important;
  padding: 0 !important;
  border-radius: 0 !important;
  font-size: inherit !important;
}
.rt-inspector-iso h3,
.rt-inspector-iso h4 {
  color: #0f172a !important;
  border: none !important;
  margin-top: 0 !important;
}
.rt-inspector-iso button {
  background: #f1f5f9 !important;
  color: #334155 !important;
  border: 1px solid #cbd5e1 !important;
  border-radius: 6px !important;
  padding: 4px 12px !important;
  cursor: pointer !important;
  font-size: 13px !important;
}
.rt-inspector-iso button:hover {
  background: #e2e8f0 !important;
}
.rt-inspector-iso summary {
  color: #64748b !important;
  cursor: pointer !important;
}
.rt-inspector-iso strong {
  color: inherit !important;
}
.rt-inspector-iso section[data-rt-inspector] {
  color: #0f172a !important;
}
`;

/**
 * Cover the dormant preview with the reason it is dormant, plus the control that
 * starts it.
 *
 * With `autorun: false` Sandpack only renders its own Run button in the code
 * editor's bottom-right corner — far from the empty preview the reader is
 * actually looking at, and with nothing explaining why that panel is blank. This
 * overlay puts the affordance where the eye already is and disappears the moment
 * the sandbox starts.
 */
function PreviewRunOverlay() {
  const { sandpack } = useSandpack();
  // Only cover a sandbox that has never been started. Deliberately an allowlist
  // rather than `!== 'running'`: on `timeout` (the bundler failing to connect)
  // Sandpack renders its own error UI with a retry, and an overlay drawn over
  // that would hide the failure instead of reporting it.
  if (sandpack.status !== 'idle' && sandpack.status !== 'initial') return null;

  return (
    <div className="rt-run-overlay">
      <p className="rt-run-overlay-title">Live preview</p>
      <p className="rt-run-overlay-body">
        The decision on the right is already live. Run the example to render it in
        a real React sandbox.
      </p>
      <RunButton />
    </div>
  );
}

/** Host-side inspector panel — runs the real SDK outside Sandpack's iframe */
function InspectorPanel({
  scenario,
  selectedUserId,
  onUserChange,
}: {
  scenario: SandpackScenario;
  selectedUserId: string;
  onUserChange: (userId: string) => void;
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
    <div className="rt-inspector-wrap">
      <div className="rt-inspector-header">
        <div>
          <div className="rt-inspector-title">Placement Decision Inspector</div>
          <div className="rt-inspector-meta">
            {scenario.slotId} · {selectedUser.label}
          </div>
        </div>
        <div className="rt-inspector-controls">
          <label htmlFor="rt-user-select">User:</label>
          <select
            id="rt-user-select"
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
      <div className="rt-inspector-body rt-inspector-iso">
        {isReady ? (
          <PlacementDecisionInspector
            key={`${scenario.id}:${selectedUserId}:${revision}`}
            surfaceSlot={{
              id: scenario.slotId,
              surfaceTemplateIds: scenario.surfaceTemplateIds,
            }}
            userId={selectedUser.context.id}
            showRawJson
          />
        ) : (
          <div style={{ fontSize: 13, color: '#94a3b8' }}>
            Preparing decision inspector…
          </div>
        )}
      </div>
    </div>
  );
}

function InspectorRoot({
  scenario,
  selectedUserId,
  onUserChange,
}: {
  scenario: SandpackScenario;
  selectedUserId: string;
  onUserChange: (userId: string) => void;
}) {
  const options = useMemo(
    () => ({
      localRuntime: { exportedConfig: exportedConfigJson },
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
      <InspectorPanel scenario={scenario} selectedUserId={selectedUserId} onUserChange={onUserChange} />
    </RevTurbineProvider>
  );
}

export default function SandpackPlayground({ scenarioId }: SandpackPlaygroundProps) {
  const scenario = sandpackScenarios.find((s) => s.id === scenarioId);
  const [selectedUserId, setSelectedUserId] = useState(scenario?.demoUserId ?? 'user_alice');

  if (!scenario) {
    return (
      <div style={{ padding: 16, color: 'red', fontFamily: 'system-ui' }}>
        Unknown scenario: <code>{scenarioId}</code>
      </div>
    );
  }

  const files = useMemo(() => buildSandpackFiles(scenario, selectedUserId), [scenario, selectedUserId]);

  return (
    <div className="rt-playground">
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
          // `user-visible` keeps a sandbox dormant until it is actually scrolled
          // into view, and `autorun: false` means even then it only bundles when
          // the reader presses Run. The decision inspector beside it is
          // host-side, so each example still shows a live, real-SDK decision
          // before anything is bundled — the Run button buys the preview only.
          initMode: 'user-visible',
          autorun: false,
        }}
      >
        {/* Top-left — live preview (dormant until the reader presses Run) */}
        <div className="rt-panel-preview">
          <PreviewRunOverlay />
          <SandpackPreview />
        </div>

        {/* Top-right — decision inspector */}
        <InspectorRoot
          scenario={scenario}
          selectedUserId={selectedUserId}
          onUserChange={setSelectedUserId}
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
