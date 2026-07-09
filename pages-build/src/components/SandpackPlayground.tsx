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

function buildSandpackFiles(scenario: SandpackScenario, selectedUserId: string): Record<string, string> {
  const componentName = scenario.component;
  const templateIdsLiteral = JSON.stringify(scenario.surfaceTemplateIds);

  // Headless scenarios use imperative SDK API
  if (componentName === 'HeadlessPlacement' || componentName === 'HeadlessEntitlementGate' || componentName === 'HeadlessSession') {
    const appCode = generateHeadlessAppCode(scenario, selectedUserId, componentName, templateIdsLiteral);
    return {
      '/App.tsx': appCode,
      '/demoUsers.ts': demoUsersRaw as string,
      '/shared.ts': sharedRaw as string,
      '/exported_config.json': exportedConfigRaw as string,
    };
  }

  // Component scenarios use RevTurbineProvider
  let componentJsx: string;
  switch (componentName) {
    case 'Gate':
      componentJsx = `      <${componentName}
          id="${scenario.slotId}"
          surfaceTemplateIds={${templateIdsLiteral}}
          check={{ entitlement: "${scenario.entitlementHandle}" }}
        >
          <div style={{ padding: 16, background: "#e8f5e9", borderRadius: 8, border: "1px solid #a5d6a7" }}>
            ✅ Access granted — premium content visible
          </div>
        </${componentName}>`;
      break;
    default:
      componentJsx = `      <${componentName}
          id="${scenario.slotId}"
          surfaceTemplateIds={${templateIdsLiteral}}
        />`;
  }

  return {
    '/App.tsx': `import React, { useMemo } from "react";
import {
  RevTurbineProvider,
  ${componentName},
} from "@revturbine/sdk";
import exportedConfig from "./exported_config.json";
import { demoUsers } from "./demoUsers";

const selectedUserId = ${JSON.stringify(selectedUserId)};
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
${componentJsx}
    </RevTurbineProvider>
  );
}
`,
    '/demoUsers.ts': demoUsersRaw as string,
    '/shared.ts': sharedRaw as string,
    '/exported_config.json': exportedConfigRaw as string,
  };
}

function generateHeadlessAppCode(
  scenario: SandpackScenario,
  selectedUserId: string,
  componentName: string,
  templateIdsLiteral: string,
): string {
  switch (componentName) {
    case 'HeadlessPlacement':
      return `import React, { useEffect, useState, useRef } from "react";
import { initRevTurbine, PlacementController } from "@revturbine/sdk/headless";
import exportedConfig from "./exported_config.json";
import { demoUsers } from "./demoUsers";

const selectedUserId = ${JSON.stringify(selectedUserId)};
const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export default function App() {
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

const selectedUserId = ${JSON.stringify(selectedUserId)};
const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export default function App() {
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

const selectedUserId = ${JSON.stringify(selectedUserId)};
const activeUser = demoUsers[selectedUserId] ?? demoUsers.user_alice;

export default function App() {
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
/* SandpackProvider renders a wrapper div — make it a 2-row grid */
.rt-playground > .sp-wrapper {
  display: grid !important;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 520px auto;
}

/* Top-left: preview */
.rt-panel-preview {
  min-width: 0;
  height: 100%;
  overflow: hidden;
  border-right: 1px solid var(--rt-border);
  border-bottom: 1px solid var(--rt-border);
}
.rt-panel-preview .sp-preview-container,
.rt-panel-preview .sp-preview-iframe {
  height: 100% !important;
  min-height: 520px !important;
}

/* Top-right: inspector (placed outside SandpackProvider, see below) */

/* Bottom: code editor — spans full width */
.rt-panel-editor {
  grid-column: 1 / -1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 480px;
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

/* ── Inspector panel (top-right, beside preview) ────────────────────── */
.rt-inspector-wrap {
  display: flex;
  flex-direction: column;
  background: var(--rt-surface-alt);
  overflow: hidden;
  border-bottom: 1px solid var(--rt-border);
  height: 100%;
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
        }}
      >
        {/* Top-left — live preview */}
        <div className="rt-panel-preview">
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
          <SandpackCodeEditor showLineNumbers showTabs />
        </div>
      </SandpackProvider>
    </div>
  );
}
