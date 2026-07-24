'use client';

import React, { useCallback } from 'react';
import { useTrack, type TrackOptions } from './useTrack';
import type { SdkEventProperties } from '../customer-side';

function isProductionBuild(): boolean {
  const processLike = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  return processLike?.env?.NODE_ENV === 'production';
}

function devWarn(message: string): void {
  if (!isProductionBuild() && typeof console !== 'undefined') console.warn(`[RevTurbine] ${message}`);
}

/** Props for {@link Track}. */
export interface TrackProps {
  /** Event name to emit on click. */
  event: string;
  /** Event data (reserved names are dropped by {@link useTrack}). */
  data?: SdkEventProperties;
  /** Track options (area / action / purpose / once / dedupeKey / immediate). */
  options?: TrackOptions;
  /**
   * Compose the telemetry onto the **single child element** instead of rendering
   * a wrapper (Radix-Slot style). Preserves the child's accessible name, disabled
   * state, and existing `onClick`.
   */
  asChild?: boolean;
  /** Host element tag when not `asChild`. Default `'span'`. */
  as?: keyof React.JSX.IntrinsicElements;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

type ClickableProps = { onClick?: React.MouseEventHandler };

/**
 * Fire a telemetry event on click (plan 144 TASK-16 / REQ-22, AC-14).
 *
 * With `asChild`, it **composes onto the single child element** rather than
 * wrapping it: the child's own `onClick` runs first, and the telemetry fires only
 * if the child did **not** `preventDefault`. Because it clones the child (no
 * wrapper element, no added `role`/`tabIndex`), the child's accessible name and
 * disabled state are unchanged (REQ-19). Without `asChild` it renders a host
 * element (default `<span>`).
 */
export function Track({
  event,
  data,
  options,
  asChild,
  as = 'span',
  className,
  style,
  children,
}: TrackProps): React.ReactElement {
  const track = useTrack();
  const fire = useCallback(
    (e: React.SyntheticEvent) => {
      if (!e.defaultPrevented) track(event, data, options);
    },
    [track, event, data, options],
  );

  if (asChild) {
    // toArray (not Children.only) so an incompatible child hits the warning path
    // instead of throwing.
    const only = React.Children.toArray(children);
    const child = only.length === 1 ? only[0] : null;
    if (!child || !React.isValidElement(child)) {
      devWarn('<Track asChild> requires a single React element child; rendering children unchanged.');
      return <>{children}</>;
    }
    const typedChild = child as React.ReactElement<ClickableProps>;
    const childOnClick = typedChild.props.onClick;
    const onClick: React.MouseEventHandler = (e) => {
      childOnClick?.(e); // the child's handler runs first and may preventDefault
      fire(e);
    };
    return React.cloneElement(typedChild, { onClick });
  }

  return React.createElement(as, { className, style, onClick: fire }, children);
}

/**
 * Telemetry props to spread onto a primitive that **cannot take a wrapper** and
 * so can't use `<Track asChild>` (plan 144 TASK-16 / REQ-22). Returns an
 * `onClick` bound to the enclosing {@link TelemetryScope}; the caller composes it
 * with any handler of their own. Respects `preventDefault` — if a prior handler
 * prevents default, the event does not fire.
 *
 * @example
 * ```tsx
 * const t = useTelemetryProps('cta_clicked', { plan: 'pro' });
 * <button {...t}>Upgrade</button>
 * ```
 */
export function useTelemetryProps(
  event: string,
  data?: SdkEventProperties,
  options?: TrackOptions,
): { onClick: React.MouseEventHandler } {
  const track = useTrack();
  const onClick = useCallback<React.MouseEventHandler>(
    (e) => {
      if (!e.defaultPrevented) track(event, data, options);
    },
    [track, event, data, options],
  );
  return { onClick };
}
