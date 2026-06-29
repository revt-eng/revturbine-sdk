/**
 * Unit tests for the web-SDK value-level PII redactor (plan 106 TASK-2).
 *
 * The corpus cases are driven from the SHARED fixture
 * `tests/fixtures/pii-redaction-corpus.json` (REQ-2 / AC-8) — byte-identical
 * to the copy in revturbine-web, so the server and SDK redactors cannot
 * drift. These cases also exercise the bundled synchronous SHA-256, proving
 * its `eml_<sha256-16>` hashes match the server's node:crypto digest.
 */
import { describe, expect, it } from 'vitest';
import corpus from '../tests/fixtures/pii-redaction-corpus.json';
import { redactPii, redactIdentityField, looksLikeEmail } from './pii-redact';

describe('web-sdk pii-redact — shared corpus (redactPii)', () => {
  for (const c of corpus.redactPii) {
    it(c.name, () => {
      const result = redactPii(c.input);
      expect(result.value).toEqual(c.expected);
      expect(result.redactions).toBe(c.redactions);
    });
  }
});

describe('web-sdk pii-redact — shared corpus (identity hashing)', () => {
  for (const c of corpus.identity) {
    it(c.name, () => {
      const result = redactIdentityField(c.input);
      expect(result.value).toBe(c.expected);
      expect(result.redacted).toBe(c.redacted);
    });
  }
});

describe('web-sdk pii-redact — input immutability', () => {
  it('does not mutate the input object', () => {
    const input = { profile: { note: 'user@example.com' } };
    redactPii(input);
    expect(input.profile.note).toBe('user@example.com');
  });
});

describe('web-sdk pii-redact — looksLikeEmail', () => {
  it('matches a whole-string email', () => {
    expect(looksLikeEmail('user@example.com')).toBe(true);
  });
  it('rejects an id that merely contains an @', () => {
    expect(looksLikeEmail('handle@')).toBe(false);
    expect(looksLikeEmail('u-123')).toBe(false);
  });
});
