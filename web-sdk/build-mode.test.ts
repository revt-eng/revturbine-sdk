/**
 * Plan 184 — build-mode detection.
 *
 * The regression this pins: the five previous copies read
 * `(globalThis as {process?: …}).process?.env?.NODE_ENV`, which type-checks
 * without `@types/node` but is NOT the token bundlers substitute. In a bundled
 * browser app the lookup stayed dynamic, `NODE_ENV` read as `undefined`, and
 * every dev-only warning shipped to production consoles.
 *
 * Vitest runs under Node, so `process` is a real global here and the token is
 * not substituted — these tests exercise the runtime ladder. The *inlining*
 * half is guarded by the emitted-source assertion at the bottom, which is the
 * only thing that can catch a regression back to the `globalThis` form.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isDevelopmentBuild, isProductionBuild, devWarn } from './build-mode';

const ORIGINAL = process.env.NODE_ENV;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL;
});

describe('isProductionBuild', () => {
  it('is true only for an explicit production NODE_ENV', () => {
    process.env.NODE_ENV = 'production';
    expect(isProductionBuild()).toBe(true);
  });

  it('is false in development', () => {
    process.env.NODE_ENV = 'development';
    expect(isProductionBuild()).toBe(false);
  });

  it('fails toward development when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(isProductionBuild()).toBe(false);
  });
});

describe('isDevelopmentBuild', () => {
  it('is false in a production build', () => {
    process.env.NODE_ENV = 'production';
    expect(isDevelopmentBuild()).toBe(false);
  });

  it('is true in a development build', () => {
    process.env.NODE_ENV = 'development';
    expect(isDevelopmentBuild()).toBe(true);
  });

  it('treats a process with no NODE_ENV as development (bare Node script)', () => {
    delete process.env.NODE_ENV;
    expect(isDevelopmentBuild()).toBe(true);
  });
});

describe('devWarn', () => {
  it('is silent in a production build', () => {
    process.env.NODE_ENV = 'production';
    const calls: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      devWarn('should not appear');
    } finally {
      console.warn = original;
    }
    expect(calls).toHaveLength(0);
  });

  it('warns with the RevTurbine prefix in a development build', () => {
    process.env.NODE_ENV = 'development';
    const calls: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => calls.push(msg);
    try {
      devWarn('hello');
    } finally {
      console.warn = original;
    }
    expect(calls).toEqual(['[RevTurbine] hello']);
  });
});

describe('bundler inlining contract', () => {
  /**
   * The whole point of the fix. A bundler replaces the literal source token
   * `process.env.NODE_ENV`; it does not follow a `globalThis` member access.
   * If someone "simplifies" this back to `globalThis`, dev warnings silently
   * ship to production again — exactly the defect plan 184 fixed — and no
   * behavioral test under Node would notice, because `process` is real here.
   */
  const source = codeOnly(readFileSync(join(__dirname, 'build-mode.ts'), 'utf-8'));

  it('reads NODE_ENV as the literal token bundlers substitute', () => {
    expect(source).toContain('process?.env?.NODE_ENV');
  });

  it('never routes the NODE_ENV read through globalThis', () => {
    // Comments are stripped first — this file's own docs quote the broken form
    // on purpose, and matching prose would make the guard self-defeating.
    const globalThisProcessRead = /globalThis[^;]*\bprocess\b/;
    expect(globalThisProcessRead.test(source)).toBe(false);
  });

  it('is the only NODE_ENV reader left in web-sdk', () => {
    // Guards against a sixth copy reappearing. Scoped to non-test sources.
    const offenders = collectNodeEnvReaders(join(__dirname));
    expect(offenders).toEqual([]);
  });
});

/**
 * Strip comments so the source guards above assert on CODE, not prose. Line
 * comments must be preceded by start-of-line or whitespace, so `https://…`
 * inside a string literal survives.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Non-test web-sdk files (other than build-mode.ts) whose CODE reads NODE_ENV. */
function collectNodeEnvReaders(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'generated') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.(test|stories)\.tsx?$/.test(entry)) continue;
      if (entry === 'build-mode.ts') continue;
      if (codeOnly(readFileSync(full, 'utf-8')).includes('NODE_ENV')) {
        found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
      }
    }
  };
  walk(root);
  return found;
}
