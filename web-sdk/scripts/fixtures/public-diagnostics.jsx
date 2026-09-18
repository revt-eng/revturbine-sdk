import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RevTurbineProvider, RevTurbineThemeProvider, useRevTurbine,
  useRevTurbineTheme, resolveBranding,
} from '@revturbine/sdk';

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
