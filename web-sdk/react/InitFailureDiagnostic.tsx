'use client';

import React from 'react';
import type { RevTurbineInitStatus } from './init-status';

/**
 * Development-only visual surface for a failed SDK initialization.
 *
 * Plan 233 TASK-2. The provider renders this beside `children` when init threw
 * and the build is not production. It exists because the app renders correctly
 * without RevTurbine **by design** — a failed init changes nothing a developer
 * can see, so the only prior signal was one `console.error` line competing with
 * everything else in the log. That cost a customer 36 hours.
 *
 * Deliberately self-contained: inline styles, no theme tokens, no portal. The
 * theme itself resolves during init, so a diagnostic that depended on it would
 * be least reliable exactly when it is needed. It must never throw — a crashing
 * error reporter is worse than none.
 *
 * @public
 */
export interface InitFailureDiagnosticProps {
  /** The failed status. Rendering is the caller's decision; this only draws. */
  status: RevTurbineInitStatus;
}

const CONTAINER: React.CSSProperties = {
  position: 'fixed',
  zIndex: 2147483647,
  bottom: 16,
  left: 16,
  maxWidth: 460,
  padding: '12px 14px',
  borderRadius: 8,
  border: '1px solid #f5a5a5',
  background: '#fff5f5',
  color: '#7f1d1d',
  font: '13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const HEADING: React.CSSProperties = { fontWeight: 700, marginBottom: 6 };
const LABEL: React.CSSProperties = { opacity: 0.75 };
const BLOCK: React.CSSProperties = { marginTop: 6 };

/**
 * Render a development-only banner describing a failed SDK initialization.
 *
 * Returns `null` for a healthy status, so the caller can render it
 * unconditionally in development without branching.
 *
 * @public
 */
export function InitFailureDiagnostic({ status }: InitFailureDiagnosticProps) {
  if (status.ok) return null;

  return (
    <div style={CONTAINER} role="alert" data-revturbine-init-failure="true">
      <div style={HEADING}>RevTurbine did not start</div>
      <div style={BLOCK}>
        <span style={LABEL}>phase: </span>
        {status.phase ?? 'unknown'}
      </div>
      {status.message ? (
        <div style={BLOCK}>
          <span style={LABEL}>error: </span>
          {status.message}
        </div>
      ) : null}
      {status.remediation ? (
        <div style={BLOCK}>
          <span style={LABEL}>fix: </span>
          {status.remediation}
        </div>
      ) : null}
      <div style={{ ...BLOCK, ...LABEL }}>
        Development build only — this banner is not rendered in production.
      </div>
    </div>
  );
}

InitFailureDiagnostic.displayName = 'InitFailureDiagnostic';
