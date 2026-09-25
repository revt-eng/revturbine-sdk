/**
 * BL-0131 / Kent's ruling **D-19** (2026-09-25) — the browser SDK warns, once
 * and gently, when an identity value looks like an email.
 *
 * > *"Not treated as PII, but a PII leak still detectable. We want our customers
 * > to use UUIDs, but if they pass an email, we need to hash it consistently."*
 *
 * `identify()` has warned on an email-shaped `user_id` since plan 191.
 * `account_id` — the OTHER identity key, and the one `monetization_funnel` and
 * `cohort_rollup` build their account map from — had no warning at all, so the
 * more consequential of the two mistakes was the silent one. This suite pins
 * both, plus the three properties that make the diagnostic usable rather than
 * noise:
 *
 * 1. **The SDK does not hash.** Detection only. Consistent hashing is the ingest
 *    boundary's job — the two write lanes must agree on one key, and a client
 *    that hashed independently would also diverge from offline decisions
 *    evaluated against the un-hashed context.
 * 2. **Once per mistake**, so a per-navigation `identify()` or a re-render
 *    cannot turn one bad id into a console flood.
 * 3. **Never on a legitimate id**, including shapes that merely resemble PII.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_d19',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/**
 * The once-per-mistake ledger is module-scoped BY DESIGN — one message per
 * mistake per page, not per SDK instance. Rather than export a test-only reset
 * (which would put a new symbol on the SDK's public surface for no customer
 * benefit), every case below uses its OWN address. A shared literal would make
 * the second case silently observe the first case's suppression and pass for the
 * wrong reason.
 */
let seq = 0;
const freshEmail = (local = 'jane'): string => `${local}.${(seq += 1)}@example.com`;

afterEach(() => vi.restoreAllMocks());

const identityWarnings = (): string[] =>
  warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('email-shaped'));

describe('an email-shaped identity value is reported', () => {
  it('warns on an email-shaped user id', () => {
    makeSdk().identify(freshEmail());

    expect(identityWarnings()).toHaveLength(1);
    expect(identityWarnings()[0]).toContain('email-shaped user id');
    expect(identityWarnings()[0]).toContain('UUID');
  });

  it('warns on an email-shaped account_id — the case that was silent', () => {
    makeSdk().identify('u_42', { account_id: freshEmail('owner') });

    expect(identityWarnings()).toHaveLength(1);
    expect(identityWarnings()[0]).toContain('email-shaped account_id');
  });

  it('warns about BOTH keys when both are email-shaped', () => {
    makeSdk().identify(freshEmail(), { account_id: freshEmail('owner') });

    const warnings = identityWarnings();
    expect(warnings).toHaveLength(2);
    expect(warnings.some((m) => m.includes('user id'))).toBe(true);
    expect(warnings.some((m) => m.includes('account_id'))).toBe(true);
  });

  it('warns via setUserContext too, so the diagnostic is not trivially avoidable', () => {
    makeSdk().setUserContext({ id: 'u_42', account_id: freshEmail('owner') });

    expect(identityWarnings()).toHaveLength(1);
    expect(identityWarnings()[0]).toContain('email-shaped account_id');
  });

  it('tells the caller what ingest will do, so the warning is actionable', () => {
    makeSdk().identify(freshEmail());

    const message = identityWarnings()[0];
    // Names the fix...
    expect(message).toContain('{ email }');
    // ...and sets the expectation that analytics still work, so nobody reads
    // this as "your data is being dropped".
    expect(message).toContain('join');
  });
});

describe('the warning fires once per mistake, not once per call', () => {
  it('warns once across repeated identify() calls with the same bad id', () => {
    const sdk = makeSdk();
    const email = freshEmail();
    sdk.identify(email);
    sdk.identify(email);
    sdk.identify(email);

    expect(identityWarnings()).toHaveLength(1);
  });

  it('still warns for a DIFFERENT bad id — a single global flag would hide it', () => {
    const sdk = makeSdk();
    sdk.identify(freshEmail('jane'));
    sdk.identify(freshEmail('bob'));

    expect(identityWarnings()).toHaveLength(2);
  });

  it('distinguishes the two fields for the same value', () => {
    // The same address in `user_id` and in `account_id` are two separate
    // mistakes with two separate fixes.
    const email = freshEmail();
    makeSdk().identify(email, { account_id: email });

    expect(identityWarnings()).toHaveLength(2);
  });
});

describe('the SDK detects but never rewrites the value', () => {
  it('leaves an email-shaped user id in the user context untouched', () => {
    // Hashing here would diverge from the offline decisions evaluated against
    // this context, and from whatever the ingest boundary stores.
    const sdk = makeSdk();
    const userEmail = freshEmail();
    const accountEmail = freshEmail('owner');
    sdk.identify(userEmail, { account_id: accountEmail });

    const context = sdk.getUserContext();
    expect(context.id).toBe(userEmail);
    expect(context.account_id).toBe(accountEmail);
  });
});

describe('a legitimate identity value raises nothing', () => {
  it.each([
    ['a UUID', '018f3e3c-8a1b-7c2d-9e4f-5a6b7c8d9e0f'],
    ['an opaque slug', 'u_42'],
    ['a ULID', '01HQ3M8Z9K7N5P2R4T6V8W0X1Y'],
    ['a long numeric id', '1055123456789012345'],
    ['a prefixed account key', 'acct_acme'],
    ['an org name', 'Acme Corp'],
  ])('stays silent for %s', (_label, id) => {
    makeSdk().identify(id, { account_id: id });
    expect(identityWarnings()).toEqual([]);
  });

  it('stays silent when an email is passed where it belongs', () => {
    makeSdk().identify('u_42', { email: freshEmail() });
    expect(identityWarnings()).toEqual([]);
  });
});
