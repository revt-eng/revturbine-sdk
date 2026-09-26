'use client';

import React, { createContext, useContext } from 'react';
import { currentBrowserRoute, normalizeSlotRoute } from '../slot-route';

/**
 * The route pattern established by the nearest {@link RevTurbineRoute}, or
 * `null` when none is mounted.
 */
const RevTurbineRouteContext = createContext<string | null>(null);

/** Props for {@link RevTurbineRoute}. */
export interface RevTurbineRouteProps {
  /**
   * The framework route pattern for this subtree — e.g. Next.js
   * `/projects/[projectId]` (see `routePatternFromParams`) or a React Router
   * pattern `/projects/:projectId`. Normalized before use: any query string,
   * fragment or origin is dropped. `null`/`undefined` falls back to the
   * browser's pathname.
   */
  route: string | null | undefined;
  children?: React.ReactNode;
}

/**
 * Declares the app route for the slots beneath it (BL-0207 / D-30). Every
 * `usePlacement()` / `<Slot>` in the subtree stamps this route onto its slot
 * lifecycle events (`slot_evaluated`, `slot_filled`, …), and ingestion-driven
 * slot discovery persists it on the discovered surface slot.
 *
 * Optional: without it, slots report `window.location.pathname` with
 * identifier-like segments templated to `:id`. Mount it when your router
 * knows the route PATTERN, so `/projects/42` and `/projects/43` are one route.
 * Renderless — adds no DOM node. The innermost boundary wins.
 *
 * @example
 * ```tsx
 * // Next.js App Router (app/layout.tsx child, a client component)
 * const route = routePatternFromParams(usePathname(), useParams());
 * return <RevTurbineRoute route={route}>{children}</RevTurbineRoute>;
 * ```
 */
export function RevTurbineRoute({ route, children }: RevTurbineRouteProps): React.ReactElement {
  const parent = useContext(RevTurbineRouteContext);
  const value = normalizeSlotRoute(route) ?? parent;
  return <RevTurbineRouteContext.Provider value={value}>{children}</RevTurbineRouteContext.Provider>;
}

/**
 * The route a slot rendered here would report: the nearest
 * {@link RevTurbineRoute} pattern, else the browser's normalized pathname,
 * else `null` (server render). Read at call time.
 */
export function useSlotRoute(): string | null {
  const declared = useContext(RevTurbineRouteContext);
  return declared ?? currentBrowserRoute();
}

export { RevTurbineRouteContext };
