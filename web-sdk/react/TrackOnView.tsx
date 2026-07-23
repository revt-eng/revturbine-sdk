'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import { exposureManager } from '../telemetry';
import { useTrack, type TrackOptions } from './useTrack';
import type { SdkEventProperties } from '../customer-side';

/** Props for {@link TrackOnView}. */
export interface TrackOnViewProps {
  /** Event name emitted once when the element is qualified-viewed. */
  event: string;
  /** Event data (reserved names are dropped by {@link useTrack}). */
  data?: SdkEventProperties;
  /** Track options (area / action / purpose / immediate). */
  options?: TrackOptions;
  /** Visible fraction required (0–1). Default 0.5. */
  threshold?: number;
  /** Minimum visible dwell before it counts, in ms. Default 0. */
  minVisibleMs?: number;
  /** Host element tag. Default `'div'`. */
  as?: keyof React.JSX.IntrinsicElements;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * Emits `event` exactly once, the first time its host element is
 * viewport-qualified (plan 144 TASK-13 / REQ-21). Falls back to firing on render
 * when `IntersectionObserver` is unavailable (AC-10 degradation). The one-shot
 * guard is a ref that survives React Strict Mode's development double-mount, so
 * the event fires once, not twice (AC-12). Renders its children in the host
 * element and never throws without a provider (AC-13).
 */
export function TrackOnView({
  event,
  data,
  options,
  threshold,
  minVisibleMs,
  as = 'div',
  className,
  style,
  children,
}: TrackOnViewProps): React.ReactElement {
  const track = useTrack();
  const firedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Latest args + track fn, read at fire time so the ref callback stays stable
  // (re-observing on every data/options change would be wrong).
  const argsRef = useRef({ event, data, options, track });
  argsRef.current = { event, data, options, track };

  const refCb = useCallback(
    (el: Element | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!el || firedRef.current) return;
      cleanupRef.current = exposureManager.observe(el, { threshold, minVisibleMs }, () => {
        if (firedRef.current) return;
        firedRef.current = true;
        const a = argsRef.current;
        a.track(a.event, a.data, a.options);
      });
    },
    [threshold, minVisibleMs],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  return React.createElement(as, { ref: refCb, className, style }, children);
}
