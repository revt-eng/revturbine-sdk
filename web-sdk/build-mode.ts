/**
 * Build-mode detection for dev-only diagnostics (plan 184).
 *
 * Every dev-only `console.warn` in the SDK is gated on one of these. They were
 * previously duplicated across five modules, and **all five were broken the
 * same way**: they read `(globalThis as {process?: …}).process?.env?.NODE_ENV`.
 *
 * That form type-checks without `@types/node` — which is why it was written —
 * but it defeats the mechanism it depends on. Bundlers substitute the **literal
 * source token** `process.env.NODE_ENV`; they do not trace a member access
 * routed through `globalThis`. So in a bundled browser app the expression stays
 * a runtime lookup, `process` is undefined, `NODE_ENV` reads as `undefined`,
 * and every "development-only" warning shipped to production consoles. That was
 * observed live on revturbine.com/app.
 *
 * The fix keeps type-checking without `@types/node` via the ambient declaration
 * below, while emitting the exact token bundlers replace. The `try`/`catch` is
 * load-bearing, not defensive noise: in raw browser ESM (unbundled, no
 * substitution) `process` is genuinely undeclared and a bare reference throws
 * `ReferenceError`.
 *
 * **Do not "simplify" this back to a `globalThis` lookup** — that is the bug.
 *
 * @internal — not part of the public SDK surface.
 */

// Ambient declaration only; `declare` emits no JavaScript, so the compiled
// output still contains the literal `process.env.NODE_ENV` token that
// webpack/turbopack/vite/esbuild replace at build time.
declare const process: { env?: { NODE_ENV?: string } } | undefined;

/**
 * `NODE_ENV` as the bundler baked it in, or `undefined` when there is no
 * `process` at all (raw browser ESM).
 *
 * @internal
 */
function readNodeEnv(): string | undefined {
  try {
    return process?.env?.NODE_ENV;
  } catch {
    return undefined;
  }
}

/** Whether a `process` global exists, regardless of whether `NODE_ENV` is set. @internal */
function hasProcessGlobal(): boolean {
  try {
    return typeof process !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * True only when the bundler baked in `NODE_ENV === 'production'`.
 *
 * Fails toward development: an unknown environment keeps diagnostics visible
 * rather than silently suppressing them.
 *
 * @internal
 */
export function isProductionBuild(): boolean {
  return readNodeEnv() === 'production';
}

/**
 * True when the SDK is running in a development build.
 *
 * Not simply `!isProductionBuild()` — it preserves the pre-existing fallback
 * ladder: an explicit `NODE_ENV` decides; a `process` with no `NODE_ENV` (a
 * bare Node script) counts as development; and with no `process` at all the
 * localhost hostname heuristic decides, so raw browser ESM still surfaces
 * diagnostics on a dev host but not on a production one.
 *
 * @internal
 */
export function isDevelopmentBuild(): boolean {
  const nodeEnv = readNodeEnv();
  if (nodeEnv !== undefined) return nodeEnv !== 'production';
  if (hasProcessGlobal()) return true;

  const locationLike = (globalThis as { location?: { hostname?: string } }).location;
  return (
    locationLike?.hostname === 'localhost'
    || locationLike?.hostname === '127.0.0.1'
    || locationLike?.hostname === '[::1]'
  );
}

/**
 * Emit a dev-only diagnostic, prefixed and silenced in production builds.
 *
 * @internal
 */
export function devWarn(message: string): void {
  if (!isDevelopmentBuild()) return;
  if (typeof console !== 'undefined') console.warn(`[RevTurbine] ${message}`);
}
