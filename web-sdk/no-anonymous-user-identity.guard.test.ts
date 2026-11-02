/**
 * ST-1416 AC-3 — guard: an anonymous id must never stand in for a user.
 *
 * The SDK used to resolve a per-browser random id (`revturbine:<ns>:anon`) and
 * fall back to it wherever it needed a user: decision/impression history,
 * storage keys, caps, event `user_id`, the account fallback. Kent (2026-11-01)
 * ruled that anonymous users never receive a playbook, so the id and every
 * fallback to it were removed. This test fails if one comes back.
 *
 * It scans the SDK's hand-written runtime source (not tests, not generated
 * output) for the shapes the old fallback took. The behavioural half — real
 * requests carry the identified user id, nothing runs without one — lives in
 * `user-required.test.ts`.
 *
 * What stays legitimate, and why this allows it: the event envelope's
 * `anonymous_id` field (the core `RevTurbineEventEnvelope` contract) carries a
 * per-INSTANCE correlation id beside `user_id`. It is never persisted and never
 * used as a user; it is named `correlationId` in this file's source. The
 * keyless `anonymousTelemetry` option names the adoption beacon, which carries
 * no identity at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_SDK_DIR = dirname(fileURLToPath(import.meta.url));

function runtimeSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...runtimeSources(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|test-d|stories|fixture)\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

interface Hit { file: string; line: number; text: string }

/** Lines (comments stripped) matching `pattern`, across all runtime sources. */
function scan(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of runtimeSources(WEB_SDK_DIR)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((raw, index) => {
      const code = raw.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (pattern.test(code)) hits.push({ file: relative(WEB_SDK_DIR, file), line: index + 1, text: raw.trim() });
    });
  }
  return hits;
}

const show = (hits: Hit[]): string => hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n');

describe('no anonymous id stands in for a user (ST-1416 AC-3)', () => {
  it('the anonymous-id identifier is gone from the SDK runtime', () => {
    const hits = scan(/\banonymousId\b|\bresolveAnonymousId\b/);
    expect(hits, show(hits)).toEqual([]);
  });

  it('no per-browser anonymous id is persisted or read from storage', () => {
    const hits = scan(/revturbine:[^'"`]*:anon\b|:anon['"`]/);
    expect(hits, show(hits)).toEqual([]);
  });

  it('no user id expression falls back to an anonymous / correlation id', () => {
    const hits = scan(
      /(?:user_?[iI]d|userContext\??\.id|\.id|\bid)\s*(?:\|\||\?\?)\s*[^;)]*(?:[aA]nonymous|anon_?[iI]d|correlationId|sessionId|requestId\()/,
    );
    expect(hits, show(hits)).toEqual([]);
  });

  it('no user-id setter or storage key is handed an anonymous / correlation id', () => {
    const hits = scan(
      /(?:setUserId|userId|user_id|userScopedStorageKey|StorageKey)\s*[:(=]\s*[^;,]*(?:[aA]nonymous|correlationId|this\.sessionId)/,
    );
    expect(hits, show(hits)).toEqual([]);
  });

  it('the event envelope carries the correlation id only beside, never as, the user id', () => {
    const source = readFileSync(join(WEB_SDK_DIR, 'customer-side.ts'), 'utf8');
    // The only places the correlation id may be read.
    const reads = [...source.matchAll(/this\.correlationId(?!\s*=[^=])/g)].length;
    expect(reads).toBe(2); // envelope.anonymous_id and envelope.identity.anonymous_id
    expect(source).toMatch(/anonymous_id:\s*this\.correlationId,\s*\n\s*user_id:\s*this\.identifiedUserId \?\? null/);
    // The wire row's `user_id` is the event's own user id, filtered to identified events.
    expect(source).toMatch(/identifiedEvents\s*=\s*sanitized\.filter\(\(event\) => hasValue\(event\.user_id\)\)/);
    expect(source).not.toMatch(/event\.user_id\s*\|\|\s*event\.anonymous_id/);
  });

  it('the guard itself can see the old shapes (it is not vacuous)', () => {
    const fallback = /(?:user_?[iI]d|userContext\??\.id|\.id|\bid)\s*(?:\|\||\?\?)\s*[^;)]*(?:[aA]nonymous|anon_?[iI]d|correlationId|sessionId|requestId\()/;
    expect(fallback.test('const userId = this.userContext.id || this.anonymousId;')).toBe(true);
    expect(fallback.test('const userId = event.user_id || event.anonymous_id;')).toBe(true);
    expect(fallback.test('userId: this.userContext.id ?? this.anonymousId,')).toBe(true);
    expect(/\banonymousId\b/.test('this.impressionHistory.setUserId(this.anonymousId);')).toBe(true);
    expect(/revturbine:[^'"`]*:anon\b|:anon['"`]/.test("`revturbine:${ns}:anon`")).toBe(true);
  });
});
