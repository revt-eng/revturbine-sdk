/**
 * Slot route computation (BL-0207, ruling D-30).
 *
 * "The route of a slot should be calculated by react and emitted as part of
 * its events. Slot discovery should pick this up and be able to persist that
 * route." This module is the pure half of that: it decides what a route IS.
 * The React layer (`usePlacement` + `<RevTurbineRoute>`) decides WHEN and
 * from WHERE, and the controller stamps the result onto every slot lifecycle
 * event as `route` (scaffold `slotContextBase.route`).
 *
 * A route is a PATH, never a URL:
 *   - no origin, no query string, no fragment — query strings are where
 *     tokens, emails and search terms live, so they never reach the wire;
 *   - the framework route PATTERN when the host supplies one
 *     (`/projects/[projectId]`, `/billing/:accountId`) — kept verbatim;
 *   - otherwise the concrete `location.pathname` with identifier-like
 *     segments (numbers, UUIDs, long hex, opaque tokens, prefixed ids,
 *     email-shaped values) templated to `:id`, so neither PII nor
 *     per-entity cardinality reaches discovery.
 *
 * Pure and framework-free: exported from the headless entry so a non-React
 * host (or a Next.js app computing its own pattern) can reuse it.
 */

/** Upper bound on an emitted route — matches scaffold `SURFACE_SLOT_ROUTE_MAX_LENGTH`. */
export const SLOT_ROUTE_MAX_LENGTH = 512;

/** The placeholder an identifier-like path segment is templated to. */
export const SLOT_ROUTE_ID_PLACEHOLDER = ':id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const LONG_HEX = /^[0-9a-f]{12,}$/i;
/** `cus_Q1w2E3r4`, `tn_4bcd07d7-…`, `pi_3NxYz…` — a short prefix, an underscore, a token with a digit. */
const PREFIXED_ID = /^[a-z]{1,12}_(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}$/;
/** A long opaque token mixing letters and digits (slugs are words, tokens are not). */
const OPAQUE_TOKEN = /^(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}$/;
/** A route-pattern segment the host already templated: `[id]`, `[...slug]`, `[[...slug]]`, `:id`, `*`. */
const PATTERN_SEGMENT = /^(\[{1,2}(\.\.\.)?[A-Za-z0-9_-]+\]{1,2}|:[A-Za-z0-9_-]+\??|\*)$/;

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * `true` when a single path segment looks like an identifier or personal data
 * rather than a stable route name. Exported for tests and custom resolvers.
 */
export function isIdentifierLikeSegment(segment: string): boolean {
  const decoded = safeDecode(segment);
  if (decoded.includes('@')) return true; // email-shaped
  return (
    NUMERIC.test(decoded) ||
    UUID.test(decoded) ||
    LONG_HEX.test(decoded) ||
    PREFIXED_ID.test(decoded) ||
    OPAQUE_TOKEN.test(decoded)
  );
}

/**
 * Normalize a path, URL or route pattern into a slot route.
 *
 * Strips any origin, query string and fragment; collapses duplicate slashes
 * and a trailing slash; keeps route-pattern segments (`[id]`, `:id`)
 * verbatim; templates identifier-like segments to `:id`; bounds the result to
 * {@link SLOT_ROUTE_MAX_LENGTH}. Returns `null` for empty or non-string input.
 *
 * @example
 * ```ts
 * normalizeSlotRoute('https://app.example.com/accounts/4821/billing?tab=x#top');
 * // → '/accounts/:id/billing'
 * normalizeSlotRoute('/projects/[projectId]');
 * // → '/projects/[projectId]'
 * ```
 */
export function normalizeSlotRoute(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  let path = input.trim();
  if (path.length === 0) return null;

  // Drop origin (scheme://host) when a full URL was supplied.
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(path);
  if (origin) path = path.slice(origin[0].length);
  // Drop query string and fragment — never on the wire.
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);

  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (PATTERN_SEGMENT.test(s) ? s : isIdentifierLikeSegment(s) ? SLOT_ROUTE_ID_PLACEHOLDER : s));

  const route = `/${segments.join('/')}`;
  return route.length > SLOT_ROUTE_MAX_LENGTH ? route.slice(0, SLOT_ROUTE_MAX_LENGTH) : route;
}

/**
 * Framework route params, as Next.js `useParams()` returns them (a catch-all
 * param is an array of segments).
 */
export type SlotRouteParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Rebuild the framework route PATTERN from a concrete pathname and the
 * framework's route params — the Next.js App Router recipe, without the SDK
 * importing `next/navigation`:
 *
 * ```tsx
 * 'use client';
 * import { useParams, usePathname } from 'next/navigation';
 * import { RevTurbineRoute, routePatternFromParams } from '@revturbine/sdk';
 *
 * export function RouteBoundary({ children }: { children: React.ReactNode }) {
 *   const route = routePatternFromParams(usePathname(), useParams());
 *   return <RevTurbineRoute route={route}>{children}</RevTurbineRoute>;
 * }
 * ```
 *
 * `/projects/p_42/settings` with `{ projectId: 'p_42' }` becomes
 * `/projects/[projectId]/settings`; a catch-all `{ slug: ['a', 'b'] }`
 * becomes `[...slug]`. The result is then normalized like any other route,
 * so a segment the params did not name is still templated if it looks like
 * an identifier.
 */
export function routePatternFromParams(
  pathname: string | null | undefined,
  params: SlotRouteParams | null | undefined,
): string | null {
  if (typeof pathname !== 'string') return null;
  const base = normalizeRawPath(pathname);
  if (base === null) return null;
  let segments = base.split('/').filter((s) => s.length > 0);

  for (const [name, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      segments = segments.map((s) => (safeDecode(s) === value ? `[${name}]` : s));
      continue;
    }
    const parts = [...value];
    if (parts.length === 0) continue;
    // Catch-all: replace the first contiguous run matching the parts.
    for (let i = 0; i + parts.length <= segments.length; i++) {
      if (parts.every((p, j) => safeDecode(segments[i + j] ?? '') === p)) {
        segments = [...segments.slice(0, i), `[...${name}]`, ...segments.slice(i + parts.length)];
        break;
      }
    }
  }
  return normalizeSlotRoute(`/${segments.join('/')}`);
}

/** Strip origin/query/fragment without templating (params are matched against raw segments). */
function normalizeRawPath(input: string): string | null {
  let path = input.trim();
  if (path.length === 0) return null;
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(path);
  if (origin) path = path.slice(origin[0].length);
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  return path.length === 0 ? '/' : path;
}

/**
 * The browser's current route — `window.location.pathname`, normalized.
 * `null` outside a browser (SSR, server runtimes, workers without `location`).
 */
export function currentBrowserRoute(): string | null {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return null;
  return normalizeSlotRoute(window.location.pathname);
}
