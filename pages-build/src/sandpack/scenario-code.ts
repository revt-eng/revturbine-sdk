import type { SandpackScenario } from './scenarios';

/**
 * The code each playground scenario exists to show — pure string generation,
 * shared by the Sandpack playground (which mounts it as `/Example.tsx`) and the
 * build-time static rendering in `LivePlayground.astro`, so the same source is
 * readable before any JavaScript loads and editable once it has.
 */
export function scenarioExampleCode(scenario: SandpackScenario): string {
  const componentName = scenario.component;
  const templateIdsLiteral = JSON.stringify(scenario.surfaceTemplateIds);
  const isHeadless =
    componentName === 'HeadlessPlacement' ||
    componentName === 'HeadlessEntitlementGate' ||
    componentName === 'HeadlessSession';
  return isHeadless
    ? generateHeadlessExampleCode(scenario, componentName, templateIdsLiteral)
    : generateComponentExampleCode(scenario, componentName, templateIdsLiteral);
}

/** The scenario's actual slot usage — the code the example exists to show. */
export function generateComponentExampleCode(
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
export function generateHeadlessExampleCode(
  scenario: SandpackScenario,
  componentName: string,
  templateIdsLiteral: string,
): string {
  switch (componentName) {
    case 'HeadlessPlacement':
      return `import React, { useEffect, useState, useRef } from "react";
import { initRevTurbine, PlacementController, RuntimeMode } from "@revturbine/sdk/headless";
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
        // local_only runs against the bundled playbook — no network for
        // decisions. previewMode keeps this docs demo out of adoption
        // telemetry; omit it in your own app.
        runtimeMode: RuntimeMode.LocalOnly,
        previewMode: true,
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
import { initRevTurbine, EntitlementGate, RuntimeMode } from "@revturbine/sdk/headless";
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
        // local_only runs against the bundled playbook — no network for
        // decisions. previewMode keeps this docs demo out of adoption
        // telemetry; omit it in your own app.
        runtimeMode: RuntimeMode.LocalOnly,
        previewMode: true,
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
        // local_only runs against the bundled playbook — no network for
        // decisions. previewMode keeps this docs demo out of adoption
        // telemetry; omit it in your own app.
        runtimeMode: RuntimeMode.LocalOnly,
        previewMode: true,
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
