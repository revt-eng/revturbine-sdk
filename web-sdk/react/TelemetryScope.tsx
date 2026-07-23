'use client';

import React, { createContext, useContext, useMemo } from 'react';

/**
 * Advisory event purpose (plan 144 TASK-12 / REQ-28). A **server-side allowlist**
 * — never this client-declared value — decides whether an event feeds engagement
 * scoring. The listed values are suggestions; any string is accepted.
 */
export type TrackPurpose = 'engagement' | 'conversion' | 'operational' | 'diagnostic' | (string & {});

/**
 * Ambient telemetry context established by {@link TelemetryScope} and merged into
 * every event emitted by {@link useTrack} beneath it.
 */
export interface TelemetryScopeValue {
  /** Logical product area (e.g. `'billing'`, `'editor'`). */
  area?: string;
  /** Default action label for events in this scope. */
  action?: string;
  /** Advisory {@link TrackPurpose}. */
  purpose?: TrackPurpose;
}

const TelemetryScopeContext = createContext<TelemetryScopeValue>({});

/** Props for {@link TelemetryScope}. */
export interface TelemetryScopeProps extends TelemetryScopeValue {
  children?: React.ReactNode;
}

/**
 * Establishes ambient telemetry context (`area` / `action` / `purpose`) for its
 * descendants (plan 144 TASK-12 / REQ-21). Nested scopes merge
 * **inner-over-outer**, and per-event {@link useTrack} options override the
 * scope (the outer → inner → invocation precedence). It is renderless — renders
 * its children unchanged, adds no DOM node (REQ-19), and works with or without a
 * RevTurbine provider (AC-13).
 */
export function TelemetryScope({ children, ...scope }: TelemetryScopeProps): React.ReactElement {
  const parent = useContext(TelemetryScopeContext);
  const value = useMemo<TelemetryScopeValue>(
    () => ({
      area: scope.area ?? parent.area,
      action: scope.action ?? parent.action,
      purpose: scope.purpose ?? parent.purpose,
    }),
    [scope.area, scope.action, scope.purpose, parent],
  );
  return <TelemetryScopeContext.Provider value={value}>{children}</TelemetryScopeContext.Provider>;
}

/** The current merged telemetry scope (plan 144 TASK-12). Empty when outside any {@link TelemetryScope}. */
export function useTelemetryScope(): TelemetryScopeValue {
  return useContext(TelemetryScopeContext);
}

export { TelemetryScopeContext };
