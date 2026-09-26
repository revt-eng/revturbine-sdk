/**
 * BL-0207 / D-30 — what a slot route IS. Pure: no DOM, no React.
 *
 * The invariant that matters most is the negative one: nothing from a query
 * string, fragment, origin, or an identifier/PII-shaped path segment may
 * reach the wire.
 */
import { describe, expect, it } from 'vitest';
import { PlacementController } from './controllers';
import {
  SLOT_ROUTE_MAX_LENGTH,
  isIdentifierLikeSegment,
  normalizeSlotRoute,
  routePatternFromParams,
} from './slot-route';

describe('normalizeSlotRoute', () => {
  it('keeps a plain static path', () => {
    expect(normalizeSlotRoute('/settings/billing')).toBe('/settings/billing');
    expect(normalizeSlotRoute('/')).toBe('/');
  });

  it('drops origin, query string and fragment', () => {
    expect(normalizeSlotRoute('https://app.example.com/pricing?email=a%40b.com&token=abc#plans')).toBe('/pricing');
    expect(normalizeSlotRoute('/search?q=jane+doe')).toBe('/search');
    expect(normalizeSlotRoute('/docs#section-2')).toBe('/docs');
  });

  it('collapses duplicate and trailing slashes', () => {
    expect(normalizeSlotRoute('//projects///list/')).toBe('/projects/list');
    expect(normalizeSlotRoute('projects')).toBe('/projects');
  });

  it('templates identifier-like segments to :id', () => {
    expect(normalizeSlotRoute('/accounts/4821/billing')).toBe('/accounts/:id/billing');
    expect(normalizeSlotRoute('/t/3f2b8c1e-9a4d-4b7e-8c2f-1a2b3c4d5e6f/home')).toBe('/t/:id/home');
    expect(normalizeSlotRoute('/customers/cus_Q1w2E3r4T5y6')).toBe('/customers/:id');
    expect(normalizeSlotRoute('/commits/9f86d081884c7d65')).toBe('/commits/:id');
    expect(normalizeSlotRoute('/invite/aB3dE5gH7jK9mN1pQ3sT5v')).toBe('/invite/:id');
  });

  it('templates email-shaped segments, raw or percent-encoded', () => {
    expect(normalizeSlotRoute('/users/jane@example.com/profile')).toBe('/users/:id/profile');
    expect(normalizeSlotRoute('/users/jane%40example.com/profile')).toBe('/users/:id/profile');
  });

  it('keeps word slugs and framework pattern segments verbatim', () => {
    expect(normalizeSlotRoute('/blog/how-we-price-ai-credits')).toBe('/blog/how-we-price-ai-credits');
    expect(normalizeSlotRoute('/projects/[projectId]/settings')).toBe('/projects/[projectId]/settings');
    expect(normalizeSlotRoute('/docs/[...slug]')).toBe('/docs/[...slug]');
    expect(normalizeSlotRoute('/shop/[[...filters]]')).toBe('/shop/[[...filters]]');
    expect(normalizeSlotRoute('/projects/:projectId')).toBe('/projects/:projectId');
  });

  it('returns null for empty or non-string input', () => {
    expect(normalizeSlotRoute('')).toBeNull();
    expect(normalizeSlotRoute('   ')).toBeNull();
    expect(normalizeSlotRoute(null)).toBeNull();
    expect(normalizeSlotRoute(undefined)).toBeNull();
  });

  it('bounds the route length', () => {
    const long = `/${Array.from({ length: 200 }, () => 'segment').join('/')}`;
    expect(normalizeSlotRoute(long)!.length).toBe(SLOT_ROUTE_MAX_LENGTH);
  });
});

describe('isIdentifierLikeSegment', () => {
  it('does not flag ordinary route words', () => {
    for (const word of ['settings', 'billing', 'v2', 'ai-credits', 'upgrade_plan', 'dashboard']) {
      expect(isIdentifierLikeSegment(word), word).toBe(false);
    }
  });
});

describe('routePatternFromParams (Next.js App Router recipe)', () => {
  it('rebuilds the dynamic-segment pattern from usePathname() + useParams()', () => {
    expect(routePatternFromParams('/projects/p_42/settings', { projectId: 'p_42' })).toBe(
      '/projects/[projectId]/settings',
    );
  });

  it('names a slug param even when the value is not identifier-shaped', () => {
    expect(routePatternFromParams('/teams/acme/members', { team: 'acme' })).toBe('/teams/[team]/members');
  });

  it('collapses a catch-all param into [...name]', () => {
    expect(routePatternFromParams('/docs/getting-started/install', { slug: ['getting-started', 'install'] })).toBe(
      '/docs/[...slug]',
    );
  });

  it('still templates an identifier segment the params did not name', () => {
    expect(routePatternFromParams('/orgs/acme/invoices/9912', { org: 'acme' })).toBe('/orgs/[org]/invoices/:id');
  });

  it('matches percent-encoded pathname segments against decoded params and drops the query', () => {
    expect(routePatternFromParams('/u/jane%20doe?tab=1', { handle: 'jane doe' })).toBe('/u/[handle]');
  });

  it('returns null for a missing pathname (usePathname() before hydration)', () => {
    expect(routePatternFromParams(null, { id: '1' })).toBeNull();
  });
});

describe('PlacementController route emission', () => {
  function mkSdk() {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const sdk = {
      getUserContext: () => ({ user_id: 'user_1' }),
      registerSurfaceSlot: async () => 'pl_1',
      getPlacementDecision: async () => ({
        visible: false,
        placementId: 'pl_1',
        requestId: 'req_1',
        decisionSource: 'local',
        reasonCodes: [],
        content: {},
        output: null,
      }),
      trackTreatmentInteraction: async () => undefined,
      emitPlatformEvent: async (name: string, payload: Record<string, unknown>) => {
        calls.push([name, payload]);
      },
    };
    return { sdk, calls };
  }

  it('emits route: null when no route source is supplied (headless default)', async () => {
    const { sdk, calls } = mkSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new PlacementController(sdk as any, { surfaceSlot: { id: 'slot_1' } });
    await ctrl.load();
    const evaluated = calls.find(([n]) => n === 'slot_evaluated');
    expect(evaluated?.[1]).toHaveProperty('route', null);
  });

  it('normalizes a string route and reads a getter at emission time', async () => {
    const { sdk, calls } = mkSdk();
    let current = '/accounts/77/billing?tab=invoices';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new PlacementController(sdk as any, { surfaceSlot: { id: 'slot_1' }, route: () => current });
    current = '/accounts/78/plans?x=1';
    await ctrl.load();
    for (const name of ['slot_evaluated', 'slot_empty']) {
      expect(calls.find(([n]) => n === name)?.[1]).toHaveProperty('route', '/accounts/:id/plans');
    }
  });

  it('a throwing route getter degrades to null and never breaks the slot', async () => {
    const { sdk, calls } = mkSdk();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new PlacementController(sdk as any, {
      surfaceSlot: { id: 'slot_1' },
      route: () => {
        throw new Error('router not ready');
      },
    });
    await ctrl.load();
    expect(ctrl.state.error).toBe('');
    expect(calls.find(([n]) => n === 'slot_evaluated')?.[1]).toHaveProperty('route', null);
  });
});
