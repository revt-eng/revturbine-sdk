'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import { TelemetryScope, type TrackPurpose } from './TelemetryScope';
import { useTrack } from './useTrack';

/** Props for {@link EngagementArea}. */
export interface EngagementAreaProps {
  /** Logical area name — set as the telemetry scope for descendants and stamped on emitted events. */
  area: string;
  /** Event emitted once when the area is first qualified-viewed. Default `engagement_view`. */
  viewEvent?: string;
  /** Event emitted with accrued dwell (`dwell_ms`) when the area unmounts. Default `engagement_dwell`. */
  dwellEvent?: string;
  /** Event emitted when a descendant is clicked. Default `engagement_interaction`. */
  interactionEvent?: string;
  /** Advisory purpose applied to the scope and emitted events. */
  purpose?: TrackPurpose;
  /** Visible fraction required to count as viewed / dwelling (0–1). Default 0.5. */
  threshold?: number;
  /** Host element tag. Default `'div'`. */
  as?: keyof React.JSX.IntrinsicElements;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * A qualified engagement region (plan 144 TASK-13 / REQ-21). It:
 * - establishes a {@link TelemetryScope} (`area` / `purpose`) for its descendants;
 * - emits `viewEvent` **once** when first viewport-qualified — one-shot across
 *   React Strict Mode's double-mount (AC-12);
 * - accrues dwell only while the region is **onscreen and the tab is visible**,
 *   emitting `dwellEvent` with `dwell_ms` when it unmounts;
 * - bubbles descendant clicks as `interactionEvent`.
 *
 * Renders its children and never throws without a provider (AC-13).
 */
export function EngagementArea({
  area,
  viewEvent = 'engagement_view',
  dwellEvent = 'engagement_dwell',
  interactionEvent = 'engagement_interaction',
  purpose,
  threshold = 0.5,
  as = 'div',
  className,
  style,
  children,
}: EngagementAreaProps): React.ReactElement {
  const track = useTrack();
  const trackRef = useRef(track);
  trackRef.current = track;

  const firedViewRef = useRef(false);
  const inViewportRef = useRef(false);
  const docVisibleRef = useRef(true);
  const visibleSinceRef = useRef<number | null>(null);
  const accruedMsRef = useRef(0);
  const ioRef = useRef<IntersectionObserver | null>(null);

  const isActive = () => inViewportRef.current && docVisibleRef.current;

  const accrue = useCallback(() => {
    if (visibleSinceRef.current !== null) {
      accruedMsRef.current += Date.now() - visibleSinceRef.current;
      visibleSinceRef.current = null;
    }
  }, []);

  const startIfActive = useCallback(() => {
    if (isActive() && visibleSinceRef.current === null) {
      visibleSinceRef.current = Date.now();
    }
  }, []);

  const enterViewport = useCallback(() => {
    inViewportRef.current = true;
    startIfActive();
    if (!firedViewRef.current) {
      firedViewRef.current = true;
      trackRef.current(viewEvent, {}, { area, purpose });
    }
  }, [viewEvent, area, purpose, startIfActive]);

  const leaveViewport = useCallback(() => {
    accrue();
    inViewportRef.current = false;
  }, [accrue]);

  const refCb = useCallback(
    (el: Element | null) => {
      ioRef.current?.disconnect();
      ioRef.current = null;
      if (!el) return;
      if (typeof IntersectionObserver === 'undefined') {
        // No observer → treat as immediately visible (render fallback).
        enterViewport();
        return;
      }
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= threshold) enterViewport();
            else leaveViewport();
          }
        },
        { threshold },
      );
      io.observe(el);
      ioRef.current = io;
    },
    [threshold, enterViewport, leaveViewport],
  );

  // Tab visibility drives dwell accrual alongside viewport visibility.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      const nowVisible = document.visibilityState !== 'hidden';
      if (docVisibleRef.current === nowVisible) return;
      docVisibleRef.current = nowVisible;
      if (nowVisible) startIfActive();
      else accrue();
    };
    docVisibleRef.current = document.visibilityState !== 'hidden';
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [accrue, startIfActive]);

  // On unmount, flush the accrued dwell (skips the zero-dwell Strict-Mode cleanup).
  useEffect(
    () => () => {
      accrue();
      const dwellMs = accruedMsRef.current;
      if (dwellMs > 0) {
        trackRef.current(dwellEvent, { dwell_ms: dwellMs }, { area, purpose });
      }
    },
    [accrue, dwellEvent, area, purpose],
  );

  const handleClick = useCallback(() => {
    trackRef.current(interactionEvent, {}, { area, purpose });
  }, [interactionEvent, area, purpose]);

  const host = React.createElement(
    as,
    { ref: refCb, className, style, onClickCapture: handleClick },
    children,
  );
  return <TelemetryScope area={area} purpose={purpose}>{host}</TelemetryScope>;
}
