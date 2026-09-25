/**
 * The account-identity fallback contract — BL-0117 / Kent's ruling D-13.
 *
 * These are pure string functions, so the interesting assertions are the ones
 * about the LITERAL: `monetization_funnel` and `cohort_rollup` exclude
 * fallback-prefixed ids from their account denominators by matching this exact
 * marker at read time, and the same marker is re-implemented in
 * `server-python` and `server-rust` (locked cross-language by
 * `tests/parity/fixtures/account_id_fallback_prefix.json`). A drift in casing,
 * separator, or match position puts fabricated keys back into a real-account
 * count — silently, which is exactly how BL-0117 survived as long as it did.
 */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_ACCOUNT_ID_PREFIX,
  fallbackAccountId,
  isFallbackAccountId,
} from './account-identity';

describe('FALLBACK_ACCOUNT_ID_PREFIX', () => {
  it('is the exact literal the warehouse guards match on', () => {
    // Pinned as a literal, not derived: the SQL guards in
    // `monetization_funnel` / `cohort_rollup` hard-code this string, and a
    // constant that can be edited freely is not a contract.
    expect(FALLBACK_ACCOUNT_ID_PREFIX).toBe('user-fallback:');
  });
});

describe('fallbackAccountId', () => {
  it('prefixes the user id verbatim', () => {
    expect(fallbackAccountId('user_1')).toBe('user-fallback:user_1');
  });

  it('passes an already-redacted identity key through untouched', () => {
    // Redaction belongs to the caller — it already resolved the `user_id` this
    // row carries. Re-normalizing here is how the clickstream and interaction
    // lanes would stop joining.
    expect(fallbackAccountId('h_7f3c9a1b')).toBe('user-fallback:h_7f3c9a1b');
  });

  it('does not trim, lowercase, or re-encode the id', () => {
    expect(fallbackAccountId(' user 1 ')).toBe('user-fallback: user 1 ');
    expect(fallbackAccountId('User_ONE')).toBe('user-fallback:User_ONE');
  });

  it('round-trips through its own classifier', () => {
    expect(isFallbackAccountId(fallbackAccountId('anon_abc'))).toBe(true);
  });
});

describe('isFallbackAccountId', () => {
  it('accepts a fabricated key', () => {
    expect(isFallbackAccountId('user-fallback:user_1')).toBe(true);
  });

  it('rejects a real, integration-supplied account id', () => {
    // The case that keeps real accounts IN the denominator.
    expect(isFallbackAccountId('acct_acme')).toBe(false);
  });

  it('rejects the bare prefix — it carries no identity, so it is not a key', () => {
    expect(isFallbackAccountId(FALLBACK_ACCOUNT_ID_PREFIX)).toBe(false);
  });

  it('rejects absence rather than throwing', () => {
    expect(isFallbackAccountId('')).toBe(false);
    expect(isFallbackAccountId(null)).toBe(false);
    expect(isFallbackAccountId(undefined)).toBe(false);
  });

  it('matches at the START only — a containing id is a real account', () => {
    // A substring match here would drop every real account whose id happens to
    // embed the marker.
    expect(isFallbackAccountId('acct_user-fallback:x')).toBe(false);
  });

  it('is case-sensitive, matching the SQL guards', () => {
    expect(isFallbackAccountId('USER-FALLBACK:user_1')).toBe(false);
    expect(isFallbackAccountId('User-Fallback:user_1')).toBe(false);
  });
});
