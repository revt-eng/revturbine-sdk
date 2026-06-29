/**
 * pii-redact.ts — best-effort, value-level PII redaction applied in the
 * web-SDK BEFORE any event leaves the browser (plan 106, REQ-6 / REQ-7).
 *
 * This is the client-side, defense-in-depth half of the redaction story: it
 * strips obvious PII (full email addresses, Luhn-valid credit-card numbers)
 * out of the event property bag, and hashes email-shaped identity values, so
 * PII never travels over the wire. The AUTHORITATIVE gate is the matching
 * server-side scrub at `/api/track` (revturbine-web/src/lib/pii-redact.ts);
 * the two implementations are kept byte-aligned by the shared corpus at
 * `tests/fixtures/pii-redaction-corpus.json`.
 *
 * Behavior matches the server exactly: REDACT-AND-PASS (values replaced with
 * the `[REDACTED]` sentinel, events never dropped) and deterministic
 * `eml_<sha256-16>` hashing of email-shaped ids. Best-effort by design —
 * obfuscated PII, unusual formats, and non-email/non-card PII are NOT caught.
 *
 * A self-contained synchronous SHA-256 is bundled here (rather than
 * `crypto.subtle`, which is async and needs a secure context) so the redactor
 * is a pure sync function that produces identical hashes in the browser, SSR,
 * web workers, and Node — and matches the server's `node:crypto` digest.
 */

export const REDACTED = '[REDACTED]';

/** Full email address, matched anywhere within a larger string. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Whole-string email test, used for identity-field hashing (REQ-4). */
const EMAIL_EXACT_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Candidate credit-card run: 13–19 digits, optionally separated by single
 * spaces or hyphens. Luhn-validated before redaction to hold down false
 * positives (long order ids, timestamps, etc.).
 */
const CARD_CANDIDATE_RE = /\d(?:[ -]?\d){12,18}/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      let doubled = d * 2;
      if (doubled > 9) doubled -= 9;
      sum += doubled;
    } else {
      sum += d;
    }
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactStringValue(input: string): { value: string; count: number } {
  let count = 0;
  let out = input.replace(EMAIL_RE, () => {
    count += 1;
    return REDACTED;
  });
  out = out.replace(CARD_CANDIDATE_RE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      count += 1;
      return REDACTED;
    }
    return match;
  });
  return { value: out, count };
}

/** Result of a redaction pass. */
export interface RedactionResult<T> {
  /** A deep copy with obvious PII values replaced by `[REDACTED]`. */
  value: T;
  /** Number of values redacted (drives the one-time SDK console warning). */
  redactions: number;
}

/**
 * Recursively redact obvious PII (emails, Luhn-valid cards) from any value —
 * string, array, object, or primitive. Non-string leaves pass through
 * unchanged. The input is not mutated.
 *
 * @param input - Any JSON-like value (typically the event property bag).
 * @returns The redacted copy plus a count of redacted values.
 */
export function redactPii<T>(input: T): RedactionResult<T> {
  let redactions = 0;
  // Walks arbitrary JSON-shaped event data at the serialization boundary —
  // the value shape is genuinely dynamic, so `unknown` is the honest type
  // (sanctioned boundary-parse use, kept byte-aligned with the server twin).
  const walk = (v: unknown): unknown => { // sdk-ok: boundary-parse
    if (typeof v === 'string') {
      const r = redactStringValue(v);
      redactions += r.count;
      return r.value;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}; // sdk-ok: boundary-parse
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) { // sdk-ok: boundary-parse
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return { value: walk(input) as T, redactions };
}

/** True when the whole (trimmed) value is an email address. */
export function looksLikeEmail(value: string): boolean {
  return EMAIL_EXACT_RE.test(value.trim());
}

/**
 * Deterministic one-way hash of an email-shaped identity value (REQ-4). Same
 * email → same id, so per-user/per-account analytics joins survive while the
 * raw address is removed. Produces `eml_<first-16-hex-of-sha256>`, identical
 * to the server-side hash.
 *
 * @param value - The identity value (already confirmed email-shaped).
 */
export function hashEmailId(value: string): string {
  const normalized = value.trim().toLowerCase();
  return `eml_${sha256Hex(normalized).slice(0, 16)}`;
}

/**
 * Hash an identity field (`user_id` / `account_id`) iff it is email-shaped;
 * otherwise return it unchanged. Honors the spec rule that "emails must not
 * be used as user ids".
 *
 * @param value - The identity field value.
 * @returns The (possibly hashed) value plus whether a hash was applied.
 */
export function redactIdentityField(value: string): { value: string; redacted: boolean } {
  if (looksLikeEmail(value)) {
    return { value: hashEmailId(value), redacted: true };
  }
  return { value, redacted: false };
}

// --- bundled synchronous SHA-256 (FIPS 180-4) -----------------------------
// Self-contained so the redactor stays a pure sync function with no
// secure-context / crypto.subtle dependency and a digest identical to the
// server's node:crypto. Operates on the UTF-8 bytes of the input.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // surrogate pair
      const hi = code;
      const lo = str.charCodeAt(i + 1);
      i += 1;
      code = 0x10000 + ((hi & 0x3ff) << 10) + (lo & 0x3ff);
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Hex(message: string): string {
  const bytes = utf8Bytes(message);
  const bitLen = bytes.length * 8;

  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length; high word is 0 for realistic input sizes.
  for (let i = 0; i < 4; i += 1) bytes.push(0);
  bytes.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Array<number>(64);
  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = chunk + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');
}
