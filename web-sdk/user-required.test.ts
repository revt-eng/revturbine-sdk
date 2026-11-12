/**
 * @vitest-environment jsdom
 *
 * ST-1416 (SDK 0.13.0) — the SDK requires an identified user in every runtime
 * mode, and there is no anonymous fallback.
 *
 * Kent, 2026-11-01: "the playbook can't actually do anything without a
 * UserContext to evaluate against" — and anonymous users never receive a
 * playbook. So an init without a non-empty `user.id` leaves the SDK in its
 * disabled/fallback state:
 *
 *   - AC-2: no network request at all (no /api/sdk/config, no /api/track, no
 *     /api/sdk/meta), no evaluation, no user-scoped storage, ONE typed
 *     diagnostic, and never a throw into the host app;
 *   - `identify(id)` still names the user and enables the SDK; an empty id is
 *     refused the same way;
 *   - the type-level half (omitting `user` / `user.id` is a compile error) is
 *     `user-required.test-d.ts`; the static anonymous-id guard is
 *     `no-anonymous-user-identity.guard.test.ts`.
 *
 * jsdom: the keyless `sdk_init` beacon only fires in a browser, and it is one of
 * the requests that must NOT happen without a user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, RuntimeMode } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { InMemoryStorage } from './storage';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];
let errorSpy: ReturnType<typeof vi.spyOn>;

const PLAYBOOK = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  tenant_id: 't_1',
  environment_id: 'production',
  plans: [{ unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 }],
  entitlements: [{ unique_handle: 'export', name: 'Export', type: 'feature' }],
  entitlement_rules: [
    { id: 'r1', entitlement_id: 'export', targets: [{ kind: 'plan', id: 'free' }], segment_ids: [], kind: 'feature', enabled: true },
  ],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
} as never;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response);
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  // Let this test's own fire-and-forget requests land in ITS `calls`, so they
  // cannot leak into the next test's assertions.
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Storages { persistent: InMemoryStorage; session: InMemoryStorage }

/** Every mode, built the way an integrator builds it — bar the user. */
const MODES: Array<[string, (storages: Storages) => Partial<RevTurbineInitOptions>]> = [
  ['revturbine_server (keyed)', (s) => ({
    runtimeMode: RuntimeMode.Server, publicKey: 'rtk_public', tenantId: 't_1', persistentStorage: s.persistent, sessionStorage: s.session,
  })],
  ['revturbine_server (keyless — would fire the sdk_init beacon)', (s) => ({
    runtimeMode: RuntimeMode.Server, tenantId: 't_1', persistentStorage: s.persistent, sessionStorage: s.session,
    localRuntime: { playbook: PLAYBOOK },
  })],
  ['custom_endpoints', (s) => ({
    runtimeMode: RuntimeMode.CustomEndpoints, publicKey: 'rtk_public', tenantId: 't_1',
    endpointOverrides: { ingestEvents: '/x/track', ingestSdkMeta: '/x/meta' } as never,
    persistentStorage: s.persistent, sessionStorage: s.session,
  })],
  ['local_only', (s) => ({
    runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', persistentStorage: s.persistent, sessionStorage: s.session,
    localRuntime: { playbook: PLAYBOOK },
  })],
];

const NO_USER: Array<[string, unknown]> = [
  ['an omitted user', undefined],
  ['a user with no id', {}],
  ['an empty id', { id: '' }],
  ['a whitespace id', { id: '   ' }],
  ['a non-string id', { id: 42 }],
  ['a null user', null],
  ['a null id', { id: null }],
];

function build(
  modeOptions: Partial<RevTurbineInitOptions>,
  user: unknown,
): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    mode: 'snippet',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    contextPolicy: { inferUser: true, inferPage: false, routerAutoTrack: false },
    ...modeOptions,
    ...(user === undefined ? {} : { user }),
  } as RevTurbineInitOptions);
}

/** Everything a host app can reasonably do to an SDK it believes is working. */
async function exerciseEverything(sdk: RevTurbineCustomerSdk): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const placementId = await sdk.registerPlacement({ name: 'banner', route: '/' });
  out.entitlement = await sdk.checkEntitlement('export');
  out.can = await sdk.can('export');
  out.gate = await sdk.gate('export', () => 'ran');
  out.decision = await sdk.getPlacementDecision({ placementId, userId: 'someone' });
  out.content = await sdk.getPlacementContent(placementId);
  out.legacy = await sdk.getPlacement({ slotId: 'banner' });
  await sdk.track('clicked', { a: 1 });
  await sdk.capture('clicked', { a: 1 }, { immediate: true });
  await sdk.emitTrigger('trial_expiring', { days_remaining: 2 });
  await sdk.trackTreatmentInteraction({
    userId: 'someone', placementId, treatmentId: 't', interactionType: 'dismiss',
  });
  await sdk.recordImpression(placementId, 't');
  await sdk.persistPlacementTypes([]);
  out.trial = await sdk.getTrialStatus();
  out.userContext = await sdk.fetchUserContext('someone');
  await sdk.fetchClientContext('rt_client_x');
  sdk.update({ plan_handle: 'free', usage: { export: 1 } });
  sdk.setUserContext({ plan_handle: 'free' });
  await sdk.flushEvents();
  return out;
}

describe('AC-2 — init without a non-empty user id is inert in every runtime mode', () => {
  describe.each(MODES)('%s', (_mode, modeOptions) => {
    it.each(NO_USER)('with %s: no request, no evaluation, no storage, one diagnostic, no throw', async (_label, user) => {
      const storages: Storages = { persistent: new InMemoryStorage(), session: new InMemoryStorage() };
      const setPersistent = vi.spyOn(storages.persistent, 'setItem');
      const setSession = vi.spyOn(storages.session, 'setItem');

      let sdk!: RevTurbineCustomerSdk;
      expect(() => { sdk = build(modeOptions(storages), user); }).not.toThrow();
      const results = await exerciseEverything(sdk);
      // Give any (forbidden) fire-and-forget request a chance to happen.
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      sdk.dispose();

      // No network request at all — not /api/sdk/config, /api/track, /api/sdk/meta,
      // nor the CDN bootstrap, client-context or any other route.
      // The ONE exception (0.16.0): a connected SDK reports the missing user,
      // anonymously, as a single `sdk_error` with a fixed-vocabulary message.
      const metaPosts = calls.filter((c) => /\/(api\/sdk|x)\/meta$/.test(c.url));
      expect(calls.filter((c) => !metaPosts.includes(c)).map((c) => c.url)).toEqual([]);
      if (_mode === 'local_only') {
        expect(metaPosts).toEqual([]);
      } else {
        expect(metaPosts).toHaveLength(1);
        const events = (JSON.parse(String(metaPosts[0].init.body)) as { events: Array<Record<string, unknown>> }).events;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ event_type: 'sdk_error', reason: 'user_id_required', message: 'user_id_required at init' });
        for (const forbidden of ['user_id', 'account_id', 'tenant_id', 'traits']) expect(forbidden in events[0]).toBe(false);
      }

      // No evaluation: the fallback answers, stamped with the typed reason.
      expect(results.entitlement).toMatchObject({ allowed: false, status: 'denied', reason: 'user_id_required' });
      expect(results.can).toMatchObject({ allowed: false, reason: 'user_id_required' });
      expect(results.gate).toMatchObject({ ran: false });
      expect(results.decision).toMatchObject({ visible: false, decisionSource: 'fallback', reasonCodes: ['user_id_required'] });
      expect(results.legacy).toBeNull();
      expect(results.trial).toEqual({ in_trial: false });

      // No user-scoped storage, read or write.
      expect(setPersistent).not.toHaveBeenCalled();
      expect(setSession).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);

      // ONE typed diagnostic, naming the fix.
      const diagnostics = errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('user_id_required'));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain('user: { id }');
      expect(sdk.getUserRequiredDiagnostic()).toMatchObject({ code: 'user_id_required', entryPoint: 'init' });
      expect(sdk.getUserContext().user_id).toBe('');
    });
  });

  it('inferUser never creates an identity', () => {
    const sdk = build({ runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK } }, undefined);
    expect(sdk.getUserContext().user_id).toBe('');
    expect(sdk.getUserRequiredDiagnostic()?.code).toBe('user_id_required');
  });
});

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const loud = (): string[] => errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('user_id_required'));

describe('ST-1696 — `user` may be a Promise of the user (0.16.0)', () => {
  describe.each(MODES)('%s', (_mode, modeOptions) => {
    it('while pending: disabled and silent — no console output, no diagnostic, no request, no storage write', async () => {
      const storages: Storages = { persistent: new InMemoryStorage(), session: new InMemoryStorage() };
      const setPersistent = vi.spyOn(storages.persistent, 'setItem');
      const setSession = vi.spyOn(storages.session, 'setItem');

      let sdk!: RevTurbineCustomerSdk;
      expect(() => { sdk = build(modeOptions(storages), deferred<{ id: string }>().promise); }).not.toThrow();
      const results = await exerciseEverything(sdk);
      await new Promise((resolve) => { setTimeout(resolve, 5); });

      expect(errorSpy).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(sdk.getUserRequiredDiagnostic()).toBeUndefined();
      expect(calls.map((c) => c.url)).toEqual([]);
      expect(setPersistent).not.toHaveBeenCalled();
      expect(setSession).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
      // Today's disabled state, unchanged: the reason stays `user_id_required`.
      expect(results.entitlement).toMatchObject({ allowed: false, status: 'denied', reason: 'user_id_required' });
      expect(results.can).toMatchObject({ allowed: false, reason: 'user_id_required' });
      expect(results.decision).toMatchObject({ visible: false, decisionSource: 'fallback', reasonCodes: ['user_id_required'] });
      sdk.dispose();
    });
  });

  const serverKeyed = (): Partial<RevTurbineInitOptions> => ({
    runtimeMode: RuntimeMode.Server, publicKey: 'rtk_public', tenantId: 't_1',
    persistentStorage: new InMemoryStorage(), sessionStorage: new InMemoryStorage(),
  });

  it('drops events captured while pending silently, counts them, never sends them later; resolve identifies once and fires the deferred page_view', async () => {
    const user = deferred<{ id: string; plan_handle: string }>();
    const sdk = build(serverKeyed(), user.promise);
    const before = sdk.getTelemetryCounters().dropped;
    await sdk.capture('before_sign_in', { marker: 'early' }, { immediate: true });
    expect(sdk.getTelemetryCounters().dropped).toBe(before + 1);
    expect(calls).toEqual([]);

    user.resolve({ id: 'u1', plan_handle: 'free' });
    await vi.waitFor(() => expect(sdk.getUserContext().user_id).toBe('u1'));
    await sdk.flushEvents();
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/track'))).toBe(true));

    const sent = calls
      .filter((c) => c.url.endsWith('/api/track'))
      .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<{ event_name: string; properties: string }> }).events);
    expect(sent.some((e) => e.properties.includes('early') || e.event_name.includes('before_sign_in'))).toBe(false);
    // The initial page_view keeps its deferral: it is emitted when the runtime starts.
    expect(sent.map((e) => e.event_name)).toContain('clickstream_page_view');
    expect(errorSpy).not.toHaveBeenCalled();
    sdk.dispose();
  });

  it('starts Playbook delivery only when the promise resolves', async () => {
    const user = deferred<{ id: string }>();
    const sdk = build(serverKeyed(), user.promise);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    expect(calls).toEqual([]);
    user.resolve({ id: 'u1' });
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/sdk/'))).toBe(true));
    expect(sdk.getUserContext().user_id).toBe('u1');
    expect(sdk.getUserRequiredDiagnostic()).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    sdk.dispose();
  });

  it.each([
    ['a blank id', { id: '   ' }],
    ['a null id', { id: null }],
    ['null', null],
  ])('resolving to %s is the loud user_id_required error and the SDK stays disabled', async (_label, value) => {
    const user = deferred<unknown>();
    const sdk = build(serverKeyed(), user.promise as never);
    expect(loud()).toHaveLength(0);
    user.resolve(value);
    await vi.waitFor(() => expect(loud()).toHaveLength(1));
    expect(sdk.getUserRequiredDiagnostic()).toMatchObject({ code: 'user_id_required', entryPoint: 'init' });
    expect(await sdk.checkEntitlement('export')).toMatchObject({ allowed: false, reason: 'user_id_required' });
    // Only the anonymous sdk_error goes out; nothing else, and no id or rejection text in it.
    await vi.waitFor(() => expect(calls.filter((c) => c.url.endsWith('/api/sdk/meta'))).toHaveLength(1));
    expect(calls.filter((c) => !c.url.endsWith('/api/sdk/meta'))).toEqual([]);
    expect(String(calls[0].init.body)).toContain('user_id_required at user_promise_resolved_blank');
    sdk.dispose();
  });

  it('a rejection is the loud error, names the reason, and the SDK stays disabled', async () => {
    const user = deferred<{ id: string }>();
    const sdk = build(serverKeyed(), user.promise);
    user.reject(new Error('session lookup failed'));
    await vi.waitFor(() => expect(loud()).toHaveLength(1));
    expect(loud()[0]).toContain('session lookup failed');
    // The anonymous report carries a fixed message, never the rejection text.
    await vi.waitFor(() => expect(calls.filter((c) => c.url.endsWith('/api/sdk/meta'))).toHaveLength(1));
    const wire = String(calls.find((c) => c.url.endsWith('/api/sdk/meta'))?.init.body);
    expect(wire).toContain('user_id_required at user_promise_rejected');
    expect(wire).not.toContain('session lookup failed');
    expect(sdk.getUserRequiredDiagnostic()?.code).toBe('user_id_required');
    expect(await sdk.checkEntitlement('export')).toMatchObject({ allowed: false, reason: 'user_id_required' });
    sdk.dispose();
  });

  it('an explicit identify() while pending wins; the promise\'s later result does not overwrite it', async () => {
    const user = deferred<{ id: string }>();
    const sdk = build({ runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK } }, user.promise);
    sdk.identify('explicit', { plan_handle: 'free' });
    user.resolve({ id: 'from_promise' });
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    expect(sdk.getUserContext().user_id).toBe('explicit');
    expect(errorSpy).not.toHaveBeenCalled();
    sdk.dispose();
  });

  it('a blank identify() while pending does not cancel the promise', async () => {
    const user = deferred<{ id: string }>();
    const sdk = build({ runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK } }, user.promise);
    sdk.identify('');
    user.resolve({ id: 'from_promise' });
    await vi.waitFor(() => expect(sdk.getUserContext().user_id).toBe('from_promise'));
    sdk.dispose();
  });

  it('a result that arrives after dispose() applies nothing, and a late rejection logs nothing', async () => {
    const resolved = deferred<{ id: string }>();
    const a = build({ runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK } }, resolved.promise);
    a.dispose();
    resolved.resolve({ id: 'late' });
    const rejected = deferred<{ id: string }>();
    const b = build({ runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK } }, rejected.promise);
    b.dispose();
    rejected.reject(new Error('late failure'));
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    expect(a.getUserContext().user_id).toBe('');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(b.getUserRequiredDiagnostic()).toBeUndefined();
  });
});

describe('identify() still names the user', () => {
  it('rejects an empty id with the same diagnostic and keeps the held user', () => {
    const sdk = build({ runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK } }, { id: 'user_1' });
    sdk.identify('');
    sdk.identify('   ');
    expect(sdk.getUserContext().user_id).toBe('user_1');
    expect(sdk.getUserRequiredDiagnostic()).toMatchObject({ code: 'user_id_required', entryPoint: 'identify' });
    expect(errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('user_id_required'))).toHaveLength(1);
  });

  it('setUserContext cannot blank the identity either', () => {
    const sdk = build({ runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK } }, { id: 'user_1' });
    sdk.setUserContext({ id: '' });
    expect(sdk.getUserContext().user_id).toBe('user_1');
    expect(sdk.getUserRequiredDiagnostic()?.entryPoint).toBe('setUserContext');
  });

  it('a valid identify() after an init without a user enables the SDK and starts what init withheld', async () => {
    const sdk = build({
      runtimeMode: RuntimeMode.Server, publicKey: 'rtk_public', tenantId: 't_1',
      persistentStorage: new InMemoryStorage(), sessionStorage: new InMemoryStorage(),
    }, undefined);
    expect(calls.filter((c) => !c.url.endsWith('/api/sdk/meta'))).toEqual([]);

    sdk.identify('user_1', { plan_handle: 'free' });

    // The Playbook delivery that init withheld now runs, for this user.
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/sdk/'))).toBe(true));
    expect(sdk.getUserContext().user_id).toBe('user_1');
    // The disabled state is gone: the answer is no longer the typed reason.
    const result = await sdk.checkEntitlement('export');
    expect(result.reason).not.toBe('user_id_required');
    sdk.dispose();
  });

  it('a reset (sign-out) returns the SDK to the disabled state — there is no anonymous user to fall back to', async () => {
    const sdk = build({ runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK } }, { id: 'user_1', plan_handle: 'free' });
    expect((await sdk.checkEntitlement('export')).allowed).toBe(true);

    sdk.reset();

    expect(sdk.getUserContext().user_id).toBe('');
    expect(await sdk.checkEntitlement('export')).toMatchObject({ allowed: false, reason: 'user_id_required' });
    sdk.identify('user_2', { plan_handle: 'free' });
    expect((await sdk.checkEntitlement('export')).allowed).toBe(true);
  });
});

describe('the keyless sdk_init beacon', () => {
  const keyless = (user: unknown): RevTurbineCustomerSdk => build({
    runtimeMode: RuntimeMode.Server, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK },
    persistentStorage: new InMemoryStorage(), sessionStorage: new InMemoryStorage(),
  }, user);

  it('is withheld without a user…', async () => {
    keyless(undefined);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    // Only the missing-user `sdk_error` may go out (0.16.0), never the init beacon.
    expect(calls.filter((c) => c.url.endsWith('/api/sdk/meta') && String(c.init.body).includes('sdk_init'))).toHaveLength(0);
  });

  it('…and fires for an identified user, carrying no user identity and no install id', async () => {
    keyless({ id: 'user_1' });
    await vi.waitFor(() => expect(calls.filter((c) => c.url.endsWith('/api/sdk/meta'))).toHaveLength(1));
    const body = String(calls.find((c) => c.url.endsWith('/api/sdk/meta'))?.init.body);
    expect(body).not.toContain('user_1');
    expect(body.toLowerCase()).not.toContain('anonymous');
    expect(body).not.toContain('user_id');
  });
});

describe('an identified SDK keys everything to the user id', () => {
  it('writes user-scoped storage under the user id and never under a random anonymous id', async () => {
    const persistent = new InMemoryStorage();
    const session = new InMemoryStorage();
    const setKeys: string[] = [];
    for (const store of [persistent, session]) {
      const original = store.setItem.bind(store);
      store.setItem = (key: string, value: string) => { setKeys.push(key); original(key, value); };
    }
    const sdk = build({
      runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK },
      persistentStorage: persistent, sessionStorage: session,
    }, { id: 'user_7', plan_handle: 'free' });
    const placementId = await sdk.registerPlacement({ name: 'banner', route: '/' });
    await sdk.trackTreatmentInteraction({ userId: 'user_7', placementId, treatmentId: 't', interactionType: 'dismiss' });
    await sdk.getPlacementDecision({ placementId, userId: 'user_7' });
    sdk.dispose();

    const userScoped = setKeys.filter((key) => /^revturbine:(interaction-state|decision-cache|output-placement-index|presentation-caps):/.test(key));
    expect(userScoped.length).toBeGreaterThan(0);
    for (const key of userScoped) expect(key.endsWith(':user_7')).toBe(true);
    expect(setKeys.filter((key) => key.endsWith(':anon'))).toEqual([]);
  });

  it('keys impression history to the user id, and detaches it on sign-out', () => {
    const sdk = build({ runtimeMode: RuntimeMode.LocalOnly, tenantId: 't_1', localRuntime: { playbook: PLAYBOOK } }, { id: 'user_7' });
    const held = (): unknown => (sdk.impressionHistory as unknown as { userId: unknown }).userId;
    expect(held()).toBe('user_7');
    sdk.identify('user_8');
    expect(held()).toBe('user_8');
    sdk.reset();
    expect(held()).toBe('');
  });

  it('puts the identified user id on every /api/track row, and never an anonymous id in its place', async () => {
    const sdk = build({
      runtimeMode: RuntimeMode.Server, publicKey: 'rtk_public', tenantId: 't_1',
      persistentStorage: new InMemoryStorage(), sessionStorage: new InMemoryStorage(),
    }, { id: 'user_9' });
    await sdk.capture('clicked', { a: 1 }, { immediate: true });
    await sdk.flushEvents();
    const rows = calls
      .filter((c) => c.url.endsWith('/api/track'))
      .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<{ user_id: string; account_id: string; properties: string }> }).events);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.user_id).toBe('user_9');
      expect(row.account_id).toBe('user-fallback:user_9');
      const props = JSON.parse(row.properties) as { anonymous_id?: string };
      // The envelope's correlation id is not an identity.
      expect(props.anonymous_id).not.toBe(row.user_id);
    }
    sdk.dispose();
  });
});
