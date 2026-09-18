import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RevTurbineProvider, RevTurbineThemeProvider, useRevTurbine,
  useRevTurbineTheme, resolveBranding,
  initRevTurbine, SdkSession,
} from '@revturbine/sdk';
import { initRevTurbine as initHeadless, SdkSession as HeadlessSession } from '@revturbine/sdk/headless';

const playbook = {
  artifact_type: 'playbook', format_version: '1.0.0', playbook_handle: 'default',
  playbook_version_id: null, tenant_id: 'diagnostics', environment_id: 'production',
  plans: [], entitlements: [], entitlement_rules: [], segments: [], content_ui_paths: [],
};
const { plans: omitted, ...malformed } = playbook;
const failedOptions = { tenantId: 'diagnostics', runtimeMode: 'local_only', localRuntime: { playbook: malformed } };
const healthyOptions = {
  tenantId: 'diagnostics', runtimeMode: 'local_only', localRuntime: { playbook },
  branding: { theme: { colors: { background: '#5d0000' } } },
};
const appTheme = { colors: { background: '#0a0a0a' } };
globalThis.diagnostics = {
  processAbsent: typeof process === 'undefined',
  legacy: resolveBranding({ legacyConfigTheme: { colors: { background: '#123456' } } }),
};

// Exercise both public entrypoints from installed release bytes, including
// plain-JavaScript misuse that a TypeScript-only fixture would reject.
async function probeInitializers() {
  const initializers = [];
  for (const [entry, init, Session] of [
    ['root', initRevTurbine, SdkSession],
    ['headless', initHeadless, HeadlessSession],
  ]) {
    const options = {
      tenantId: 'diagnostics', runtimeMode: 'local_only', previewMode: true,
      endpoint: location.origin, localRuntime: { playbook },
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      user: { id: 'user_123', plan_handle: 'pro', custom: { region: 'eu' } },
    };
    const pending = init(options);
    const session = await pending;
    initializers.push({
      entry, isPromise: pending instanceof Promise, isSession: session instanceof Session,
      context: session.sdk.getUserContext(), plan: session.sdk.getTargeting().plan,
      branding: session.sdk.getBranding(),
    });
    session.sdk.dispose();
    const misuse = await init({
      ...options, user: { ...options.user, unknownContextKey: 'fixture-value' },
    });
    misuse.sdk.dispose();
  }
  globalThis.diagnostics.initializers = initializers;
}
void probeInitializers();

function Probe({ name }) {
  const { sdk, isReady, initStatus } = useRevTurbine();
  const theme = useRevTurbineTheme();
  useEffect(() => {
    globalThis.diagnostics[name] = {
      sdkIsNull: sdk === null, isReady, initStatus, background: theme.colors.background,
    };
  }, [sdk, isReady, initStatus, theme, name]);
  return <div data-probe={name}>host child remains visible</div>;
}

createRoot(document.getElementById('failed')).render(
  <RevTurbineProvider options={failedOptions}><Probe name="failed" /></RevTurbineProvider>,
);
createRoot(document.getElementById('healthy')).render(
  <RevTurbineThemeProvider theme={appTheme}>
    <RevTurbineProvider options={healthyOptions}><Probe name="healthy" /></RevTurbineProvider>
  </RevTurbineThemeProvider>,
);
