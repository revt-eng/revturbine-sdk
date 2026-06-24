'use client';

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PersonalizationContext, PlacementUiPath } from './types';
import type { PlacementTypeRegistry } from './registry';
import type {
  RevTurbineContextMode,
  RevTurbinePlacementDecisionOverrides,
  RevTurbineSurfaceSlotConfig,
  PlacementOutput,
} from '../customer-side';
import { useSurfaceSlot } from './useSurfaceSlot';
import { MESSAGE_SURFACE_TEMPLATE_IDS } from './surface-slot-constants';

export { MESSAGE_SURFACE_TEMPLATE_IDS };

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Trigger type that controls when the message placement evaluates and renders.
 *
 * - `'on_mount'` — Evaluate immediately when the component mounts.
 * - `'on_event'` — Evaluate when `triggerEvent` is called externally.
 * - `'on_interval'` — Re-evaluate on a polling interval.
 */
export type MessageTriggerType = 'on_mount' | 'on_event' | 'on_interval';

export type MessageSurfaceSlotProps = {
  /** Required unique identifier for this render slot. */
  id: string;
  /** Optional human-readable slot label used for analytics/debugging. */
  name?: string;

  /**
   * When the placement decision should be evaluated.
   *
   * - `'on_mount'` — Load once when the component mounts. Default.
   * - `'on_event'` — Load only when `triggerEvent` is fired via the ref.
   * - `'on_interval'` — Re-poll every `intervalMs` milliseconds.
   */
  trigger?: MessageTriggerType;

  /**
   * Polling interval in milliseconds. Only used with `trigger: 'on_interval'`.
   * Defaults to 60000 (1 minute).
   */
  intervalMs?: number;

  /**
   * Surface template IDs that this slot accepts.
   * Only placements matching one of these templates can render here.
   */
  surfaceTemplateIds?: string[];
  /** Optional metadata included in slot registration/upsert payloads. */
  metadata?: Record<string, unknown>; // sdk-ok: boundary-parse — customer-provided interaction metadata
  contextMode?: RevTurbineContextMode;
  overrides?: RevTurbinePlacementDecisionOverrides;
  traits?: Record<string, string | number | boolean>;
  personalization?: PersonalizationContext;
  registry?: PlacementTypeRegistry;
  onCtaClick?: (uiPath: PlacementUiPath) => void;
  /** Callback when a message placement is presented. */
  onPresented?: (placement: PlacementOutput) => void;
  /** Callback when the message is dismissed. */
  onDismissed?: () => void;
  className?: string;
  style?: React.CSSProperties;
};

export type MessageSurfaceSlotRef = {
  /** Programmatically trigger a placement evaluation (for `trigger: 'on_event'`). */
  triggerEvent: () => void;
  /** Refresh the current decision. */
  refresh: () => void;
};

/**
 * Message surface slot — renders push-style notifications, modals, and toasts.
 *
 * Evaluates placement decisions based on configured triggers and renders the
 * result as a notification, pop-up modal, or toast. The placement only appears
 * when the decision engine returns a match for the current user context.
 *
 * For `on_event` triggering, use the forwarded ref:
 *
 * @example
 * ```tsx
 * // Mount-triggered notification (evaluates once on mount)
 * <MessageSurfaceSlot id="trial-welcome" />
 *
 * // Event-triggered gate modal
 * const ref = useRef<MessageSurfaceSlotRef>(null);
 * <MessageSurfaceSlot id="export-nudge" trigger="on_event" ref={ref} />
 * <button onClick={() => ref.current?.triggerEvent()}>Export</button>
 *
 * // Interval-polled notification
 * <MessageSurfaceSlot
 *   id="global-messages"
 *   trigger="on_interval"
 *   intervalMs={30_000}
 * />
 * ```
 */
export const MessageSurfaceSlot = React.forwardRef<
  MessageSurfaceSlotRef,
  MessageSurfaceSlotProps
>(function MessageSurfaceSlot(
  {
    id,
    name,
    trigger = 'on_mount',
    intervalMs = 60_000,
    surfaceTemplateIds,
    metadata,
    onPresented,
    onDismissed,
    ...options
  },
  ref,
) {
  const shouldAutoLoad = trigger === 'on_mount' || trigger === 'on_interval';

  const surfaceSlot = useMemo<RevTurbineSurfaceSlotConfig>(
    () => ({
      id,
      name: name || id,
      surfaceTemplateIds: surfaceTemplateIds ?? (MESSAGE_SURFACE_TEMPLATE_IDS as string[]),
      metadata: {
        ...metadata,
        surface_slot_category: 'triggered',
        trigger_type: trigger,
      },
    }),
    [id, name, surfaceTemplateIds, metadata, trigger],
  );

  const {
    element,
    visible,
    decision,
    refresh,
    dismiss,
  } = useSurfaceSlot({
    ...options,
    autoLoad: shouldAutoLoad,
    surfaceSlot,
  });

  // Expose imperative API.
  const triggerEvent = useCallback(() => {
    refresh();
  }, [refresh]);

  React.useImperativeHandle(ref, () => ({
    triggerEvent,
    refresh,
  }), [triggerEvent, refresh]);

  // Interval polling.
  useEffect(() => {
    if (trigger !== 'on_interval') return;
    const timer = setInterval(() => refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [trigger, intervalMs, refresh]);

  // Fire onPresented when a placement becomes visible.
  const presentedRef = useRef(false);
  const onPresentedRef = useRef(onPresented);
  onPresentedRef.current = onPresented;
  useEffect(() => {
    if (visible && decision?.output && !presentedRef.current) {
      presentedRef.current = true;
      onPresentedRef.current?.(decision.output);
    }
    if (!visible) {
      presentedRef.current = false;
    }
  }, [visible, decision]);

  // Fire onDismissed when the placement is dismissed.
  const onDismissedRef = useRef(onDismissed);
  onDismissedRef.current = onDismissed;
  const handleDismissWrap = useCallback(() => {
    void dismiss();
    onDismissedRef.current?.();
  }, [dismiss]);
  // Attach dismiss override by wrapping the element if needed.
  void handleDismissWrap;

  if (!visible || !element) return null;
  return <>{element}</>;
});

MessageSurfaceSlot.displayName = 'MessageSurfaceSlot';
