/**
 * Plan 107 TASK-3: the scaffold SDK function-surface manifest is the source of
 * truth for the web-sdk's public method/alias surface. This asserts the web-sdk
 * client honors every member the manifest marks `web-client` — so a manifest
 * change (a new alias, or dropping `web-client` from one) that the web-sdk
 * hasn't adopted fails CI here, and the per-port surfaces can no longer drift
 * silently.
 *
 * Reads the canonical published artifact `@revt-eng/schema/sdk-surface.json`
 * (the same JSON the non-TS ports consume) so the assertion is robust in CI and
 * locally — independent of any locally-built `@revt-eng/core` dist.
 *
 * Direction: this is the "manifest floor" check (every declared member is
 * present). The cross-port gate (TASK-6) owns the missing-AND-extra comparison
 * across all ports.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import * as webSdkIndex from './index';

interface SdkFunctionDef {
  canonical: string;
  aliases: string[];
  kind: 'method' | 'meta' | 'component';
  appliesTo: Array<'web-client' | 'server'>;
}

const require = createRequire(import.meta.url);
const surface = JSON.parse(
  readFileSync(require.resolve('@revt-eng/schema/sdk-surface.json'), 'utf8'),
) as { functions: SdkFunctionDef[] };

const webFunctions = surface.functions.filter((fn) => fn.appliesTo.includes('web-client'));

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_manifest_test',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

function hasFunction(obj: object, name: string): boolean {
  return typeof (obj as Record<string, unknown>)[name] === 'function';
}

describe('web-sdk surface matches the scaffold manifest (plan 107)', () => {
  it('reads a non-empty web-client surface from the published manifest', () => {
    expect(webFunctions.length).toBeGreaterThan(0);
  });

  it('declares at least the plan-84 hero aliases as web-client', () => {
    const aliases = webFunctions.flatMap((fn) => fn.aliases);
    expect(aliases).toEqual(expect.arrayContaining(['can', 'track', 'update', 'reset', 'RTSlot']));
  });

  it('exposes every web-client method/meta (canonical + aliases) on the client', () => {
    const sdk = makeSdk();
    const methodDefs = webFunctions.filter((fn) => fn.kind === 'method' || fn.kind === 'meta');
    expect(methodDefs.length).toBeGreaterThan(0);
    for (const def of methodDefs) {
      for (const name of [def.canonical, ...def.aliases]) {
        expect(hasFunction(sdk, name), `client is missing manifest method "${name}"`).toBe(true);
      }
    }
  });

  it('exports every web-client component alias from the package entry', () => {
    const componentDefs = webFunctions.filter((fn) => fn.kind === 'component');
    expect(componentDefs.length).toBeGreaterThan(0);
    for (const def of componentDefs) {
      for (const alias of def.aliases) {
        expect(
          (webSdkIndex as Record<string, unknown>)[alias],
          `package entry is missing manifest component "${alias}"`,
        ).toBeDefined();
      }
    }
  });
});
