/**
 * ST-1447 (BUG-1185, BUG-1470) — the SDK never calls a default route the
 * control plane does not serve.
 *
 * `/api/sdk/user-context` (BUG-1185) and `/api/sdk/trial-status` (BUG-1470)
 * were defaults of `endpointFor()` that answered 404 on every identify(),
 * update() and getTrialStatus(). This test walks EVERY `endpointFor(key,
 * default)` call in `customer-side.ts` and requires each default path either to
 * exist on the hosted API or to sit behind `hasEndpointOverride(key)`, so the
 * request only happens when the integrator pointed that key at a real endpoint.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, type RevTurbineInitOptions } from './customer-side';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'customer-side.ts'), 'utf8');

/**
 * Hosted SDK routes: every path in the external OpenAPI spec the client is
 * generated from, plus the one hosted SDK route that spec does not describe.
 * `/api/sdk/client-context` is served by revturbine-web
 * (`src/app/api/sdk/client-context`) behind a client-session token rather than
 * the public key, so it is deliberately absent from the external spec.
 */
const HOSTED_ONLY_OUTSIDE_THE_SPEC = ['/api/sdk/client-context'];

function hostedRoutes(): Set<string> {
  const generated = readFileSync(join(HERE, 'generated', 'openapi.d.ts'), 'utf8');
  const routes = new Set<string>(HOSTED_ONLY_OUTSIDE_THE_SPEC);
  for (const match of generated.matchAll(/^ {4}"(\/[^"]+)": \{/gm)) routes.add(match[1] ?? '');
  return routes;
}

function stringConstants(): Map<string, string> {
  const constants = new Map<string, string>();
  for (const match of SOURCE.matchAll(/^const ([A-Z0-9_]+) = '([^']*)';/gm)) {
    constants.set(match[1] ?? '', match[2] ?? '');
  }
  return constants;
}

interface EndpointDefault {
  key: string;
  path: string;
}

function endpointDefaults(): EndpointDefault[] {
  const constants = stringConstants();
  const found: EndpointDefault[] = [];
  for (const match of SOURCE.matchAll(/this\.endpointFor\(\s*'([A-Za-z]+)'\s*,\s*([^)]+?)\s*\)/g)) {
    const key = match[1] ?? '';
    const argument = (match[2] ?? '').trim();
    const literal = /^'([^']*)'$/.exec(argument);
    const path = literal ? (literal[1] ?? '') : constants.get(argument);
    if (path === undefined) throw new Error(`endpointFor('${key}', ${argument}): default is neither a string literal nor a top-level constant`);
    found.push({ key, path });
  }
  return found;
}

describe('every endpointFor() default', () => {
  const defaults = endpointDefaults();

  it('finds the calls it is meant to guard', () => {
    const keys = defaults.map((entry) => entry.key);
    expect(keys).toEqual(expect.arrayContaining([
      'ingestEvents',
      'ingestSdkMeta',
      'touchpointTransition',
      'clientContext',
      'userContext',
      'trialStatus',
      'placementTypes',
    ]));
  });

  it.each(defaults.filter((entry) => entry.path !== ''))(
    '$key -> $path is a hosted route, or is gated by hasEndpointOverride',
    ({ key, path }) => {
      const served = hostedRoutes().has(path);
      const gated = SOURCE.includes(`this.hasEndpointOverride('${key}')`);
      expect(
        served || gated,
        `endpointFor('${key}', '${path}'): the control plane does not serve ${path}; gate the call with hasEndpointOverride('${key}')`,
      ).toBe(true);
    },
  );

  it('keeps the two known unserved defaults gated', () => {
    const routes = hostedRoutes();
    expect(routes.has('/api/sdk/user-context')).toBe(false);
    expect(routes.has('/api/sdk/trial-status')).toBe(false);
    expect(SOURCE).toContain("this.hasEndpointOverride('userContext')");
    expect(SOURCE).toContain("this.hasEndpointOverride('trialStatus')");
  });
});

describe('hosted getTrialStatus() and the unserved trial-status route (BUG-1470)', () => {
  let urls: string[];

  beforeEach(() => {
    urls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ in_trial: true, trial_type: 'free' }),
        text: async () => '',
      } as unknown as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
    return new RevTurbineCustomerSdk({
      tenantId: 'tenant_trial_status',
      publicKey: 'rtk_public_test',
      endpoint: 'https://edge.example.com',
      anonymousTelemetry: false,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      user: { id: 'user_1' },
      ...over,
    });
  }

  const trialStatusCalls = (): string[] => urls.filter((url) => url.includes('trial-status'));

  it('makes no request to /api/sdk/trial-status by default', async () => {
    const sdk = makeSdk();
    const status = await sdk.getTrialStatus();

    expect(trialStatusCalls()).toEqual([]);
    expect(status.in_trial).toBe(false);
    sdk.dispose();
  });

  it('reports the trial the app supplied instead of calling the route', async () => {
    const sdk = makeSdk({ user: { id: 'user_1', trial: { in_trial: true, trial_type: 'free' } } });
    const status = await sdk.getTrialStatus();

    expect(trialStatusCalls()).toEqual([]);
    expect(status.in_trial).toBe(true);
    sdk.dispose();
  });

  it('calls the route when custom_endpoints.trialStatus names one', async () => {
    const sdk = makeSdk({
      runtimeMode: 'custom_endpoints',
      endpointOverrides: { trialStatus: '/custom/trial-status' },
    });
    const status = await sdk.getTrialStatus();

    expect(urls.some((url) => url.endsWith('/custom/trial-status'))).toBe(true);
    expect(status.in_trial).toBe(true);
    sdk.dispose();
  });
});
