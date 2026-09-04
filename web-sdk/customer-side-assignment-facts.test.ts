/**
 * Plan 224 TASK-8 — `experiment_assigned` assignment-fact emission
 * (war-games spec §9.1).
 *
 * The resolved assignment snapshot is the single funnel every assignment
 * source normalizes into (native bucketer, external adapters, caller
 * context), so emission is pinned at that funnel. These tests pin the
 * load-bearing properties:
 *   - one fact per (handle, version, subject), declaration-gated;
 *   - `assignment_id` is the deterministic idempotency hash — identical
 *     across re-emissions and across SDK instances;
 *   - per-context-revision dedupe: re-resolution emits nothing new, a
 *     revision bump re-emits the SAME id (collapses in storage);
 *   - not-enrolled is absence and provider failure emits nothing — there is
 *     no `enrolled: false` fact and no fact without a real assignment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { createNativeExperimentAssignmentProvider } from './providers/basic-experiment-provider';
import type { ExperimentAssignmentProvider } from './providers/types';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' }) as unknown as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const TENANT = 'tenant_assignment_facts';

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: TENANT,
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

/** Spy on the semantic-emit funnel; short-circuits the network entirely. */
function spyOnEmits(sdk: RevTurbineCustomerSdk) {
  return vi.spyOn(sdk, 'emitSemantic').mockResolvedValue(undefined);
}

type EmitSpy = ReturnType<typeof spyOnEmits>;

function assignmentFactCalls(spy: EmitSpy): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter(([eventType]) => eventType === 'experiment_assigned')
    .map(([, payload]) => payload);
}

async function flushFacts(spy: EmitSpy, expected: number): Promise<void> {
  await vi.waitFor(() => {
    expect(assignmentFactCalls(spy).length).toBe(expected);
  });
}

/** The documented idempotency algorithm, reproduced independently. */
async function expectedAssignmentId(
  handle: string,
  version: number,
  unit: string,
  subject: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([TENANT, handle, version, unit, subject]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function nativeProvider(sequence?: number, trafficAllocation = 1) {
  return createNativeExperimentAssignmentProvider({
    experiments: [{
      handle: 'pricing_test',
      traffic_allocation: trafficAllocation,
      assignment_unit: 'user',
      variants: [
        { variant_id: 'control', weight: 0.5 },
        { variant_id: 'variant_b', weight: 0.5 },
      ],
      ...(sequence !== undefined ? { sequence } : {}),
    }],
    subject: 'user-42',
  });
}

describe('experiment_assigned assignment facts (plan 224 TASK-8)', () => {
  it('emits one fact from the native provider with the full §9.1 property set', async () => {
    const sdk = makeSdk({ domainProviders: [nativeProvider(3)] });
    const spy = spyOnEmits(sdk);

    await sdk.getEffectiveUserContext();
    await flushFacts(spy, 1);

    const fact = assignmentFactCalls(spy)[0];
    expect(fact.schema_version).toBe(1);
    expect(fact.experiment_id).toBe('pricing_test'); // wire field carries the HANDLE
    expect(fact.experiment_version).toBe(3);
    expect(['control', 'variant_b']).toContain(fact.variant_key);
    expect(fact.assignment_unit).toBe('user');
    expect(fact.subject_id).toBe('user-42');
    expect(fact.provider_handle).toBe('revturbine:native');
    expect(typeof fact.assigned_at).toBe('string');
    expect(fact.assignment_id).toBe(
      await expectedAssignmentId('pricing_test', 3, 'user', 'user-42'),
    );
  });

  it('is idempotent: a second SDK instance derives the identical assignment_id', async () => {
    const first = makeSdk({ domainProviders: [nativeProvider(3)] });
    const second = makeSdk({ domainProviders: [nativeProvider(3)] });
    const firstSpy = spyOnEmits(first);
    const secondSpy = spyOnEmits(second);

    await first.getEffectiveUserContext();
    await second.getEffectiveUserContext();
    await flushFacts(firstSpy, 1);
    await flushFacts(secondSpy, 1);

    expect(assignmentFactCalls(firstSpy)[0].assignment_id)
      .toBe(assignmentFactCalls(secondSpy)[0].assignment_id);
    expect(assignmentFactCalls(firstSpy)[0].variant_key)
      .toBe(assignmentFactCalls(secondSpy)[0].variant_key);
  });

  it('dedupes within a context revision and re-emits the SAME id after a revision bump', async () => {
    const sdk = makeSdk({ domainProviders: [nativeProvider(3)] });
    const spy = spyOnEmits(sdk);

    await sdk.getEffectiveUserContext();
    await sdk.getEffectiveUserContext(); // re-resolution, same revision
    await flushFacts(spy, 1);

    sdk.setUserContext({ id: 'someone-else' }); // revision bump; subject stays pinned
    await sdk.getEffectiveUserContext();
    await flushFacts(spy, 2);

    const [before, after] = assignmentFactCalls(spy);
    expect(after.assignment_id).toBe(before.assignment_id); // collapses in storage
    expect(after.subject_id).toBe('user-42');
  });

  it('emits nothing for an unenrolled subject — not-enrolled is absence', async () => {
    const sdk = makeSdk({ domainProviders: [nativeProvider(3, 0)] }); // traffic_allocation 0
    const spy = spyOnEmits(sdk);

    await sdk.getEffectiveUserContext();
    // Settle any pending microtasks before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(assignmentFactCalls(spy)).toEqual([]);
  });

  it('emits nothing without a declared canonical version (no sequence, no init declaration)', async () => {
    const sdk = makeSdk({ domainProviders: [nativeProvider(undefined)] });
    const spy = spyOnEmits(sdk);

    await sdk.getEffectiveUserContext();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(assignmentFactCalls(spy)).toEqual([]);
  });

  it('covers the composite/external-adapter path via init-level declarations', async () => {
    const adapter: ExperimentAssignmentProvider = {
      domain: 'experiments',
      providerHandle: 'acme:assignments',
      providerRevision: 7,
      resolve: () => ({ assignments: { promo_test: 'variant_b' } }),
    };
    const sdk = makeSdk({
      domainProviders: [adapter],
      experimentAssignmentFacts: [{
        experimentHandle: 'promo_test',
        experimentVersion: 2,
        assignmentUnit: 'account',
        subject: () => 'acct-9',
      }],
    });
    const spy = spyOnEmits(sdk);

    await sdk.getEffectiveUserContext();
    await flushFacts(spy, 1);

    const fact = assignmentFactCalls(spy)[0];
    expect(fact.experiment_id).toBe('promo_test');
    expect(fact.experiment_version).toBe(2);
    expect(fact.variant_key).toBe('variant_b');
    expect(fact.assignment_unit).toBe('account');
    expect(fact.subject_id).toBe('acct-9');
    expect(fact.provider_handle).toBe('acme:assignments');
    expect(fact.provider_revision).toBe('7');
    expect(fact.assignment_id).toBe(
      await expectedAssignmentId('promo_test', 2, 'account', 'acct-9'),
    );
  });

  it('emits nothing when the declared adapter fails — failure is never an assignment', async () => {
    const adapter: ExperimentAssignmentProvider = {
      domain: 'experiments',
      providerHandle: 'acme:assignments',
      ownedExperimentHandles: ['promo_test'],
      resolve: () => {
        throw new Error('vendor outage');
      },
    };
    const sdk = makeSdk({
      domainProviders: [adapter],
      experimentAssignmentFacts: [{ experimentHandle: 'promo_test', experimentVersion: 2 }],
    });
    const spy = spyOnEmits(sdk);

    await sdk.getEffectiveUserContext();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(assignmentFactCalls(spy)).toEqual([]);
  });

  it('falls back to the user-context id as subject, and emits nothing without one', async () => {
    const adapter: ExperimentAssignmentProvider = {
      domain: 'experiments',
      resolve: () => ({ assignments: { promo_test: 'control' } }),
    };
    const declared = {
      experimentAssignmentFacts: [{ experimentHandle: 'promo_test', experimentVersion: 1 }],
    } as const;

    const withUser = makeSdk({ domainProviders: [adapter], user: { id: 'u-7' }, ...declared });
    const withUserSpy = spyOnEmits(withUser);
    await withUser.getEffectiveUserContext();
    await flushFacts(withUserSpy, 1);
    expect(assignmentFactCalls(withUserSpy)[0].subject_id).toBe('u-7');
    expect(assignmentFactCalls(withUserSpy)[0].assignment_unit).toBe('user');

    const anonymous = makeSdk({ domainProviders: [adapter], ...declared });
    const anonymousSpy = spyOnEmits(anonymous);
    await anonymous.getEffectiveUserContext();
    await new Promise((resolve) => setTimeout(resolve, 25));
    // No stable subject → no fact; absent beats wrong.
    expect(assignmentFactCalls(anonymousSpy)).toEqual([]);
  });
});
