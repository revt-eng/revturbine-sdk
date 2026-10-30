'use client';

import React, { createContext, useContext, useMemo } from 'react';
import type { SdkEventProperties } from '../customer-side';

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
  /** Logical product area (e.g. `'billing'`, `'editor'`). The top of the area → feature → action hierarchy. */
  area?: string;
  /**
   * Product feature within the {@link TelemetryScopeValue.area} (e.g. `'timeline'`);
   * the middle of the area → feature → action hierarchy. Inherited per field: a
   * scope that sets `area` without `feature` keeps an outer `feature`.
   */
  feature?: string;
  /**
   * Low-cardinality, non-PII context merged into every event's properties
   * (outer → inner → per-event data, data wins). Never promoted to a column.
   * Reserved property names are dropped by {@link useTrack}.
   */
  properties?: SdkEventProperties;
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
 * Establishes ambient telemetry context (`area` / `feature` / `action` /
 * `purpose` / `properties`) for its descendants (plan 144 TASK-12 / REQ-21). The
 * product hierarchy is area → feature → action. Nested scopes merge
 * **inner-over-outer, per field** (a scope that sets `area` does not reset an
 * inherited `feature`), and per-event {@link useTrack} options override the
 * scope (the outer → inner → invocation precedence). It is renderless — renders
 * its children unchanged, adds no DOM node (REQ-19), and works with or without a
 * RevTurbine provider (AC-13).
 */
export function TelemetryScope({ children, ...scope }: TelemetryScopeProps): React.ReactElement {
  const parent = useContext(TelemetryScopeContext);
  const value = useMemo<TelemetryScopeValue>(
    () => ({
      area: scope.area ?? parent.area,
      feature: scope.feature ?? parent.feature,
      action: scope.action ?? parent.action,
      purpose: scope.purpose ?? parent.purpose,
      properties:
        scope.properties || parent.properties
          ? { ...parent.properties, ...scope.properties }
          : undefined,
    }),
    [scope.area, scope.feature, scope.action, scope.purpose, scope.properties, parent],
  );
  return <TelemetryScopeContext.Provider value={value}>{children}</TelemetryScopeContext.Provider>;
}

/** The current merged telemetry scope (plan 144 TASK-12). Empty when outside any {@link TelemetryScope}. */
export function useTelemetryScope(): TelemetryScopeValue {
  return useContext(TelemetryScopeContext);
}

export { TelemetryScopeContext };
