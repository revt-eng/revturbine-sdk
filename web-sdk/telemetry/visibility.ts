/**
 * Viewport-exposure substrate (plan 144 TASK-9).
 *
 * A small manager over `IntersectionObserver` that answers "has this element
 * actually entered the viewport?" for viewport-qualified exposure. It exists
 * for REQ-18 (attach exposure to the true visual root) and AC-10 (degrade
 * gracefully when `IntersectionObserver` is unavailable).
 *
 * Two design points the plan calls out:
 *   - **One shared observer per distinct config.** Elements requesting the same
 *     `threshold` + `rootMargin` share a single `IntersectionObserver` — one
 *     observer, many targets — rather than one observer per placement.
 *   - **Graceful fallback (AC-10).** With no `IntersectionObserver` (SSR, old
 *     browsers, a stubbed environment) the manager doesn't throw: it treats
 *     render as exposure and reports `exposure_basis: 'render_fallback'`, so the
 *     signal degrades instead of disappearing.
 */

/**
 * How an element came to be considered "exposed":
 * - `viewport` — it crossed the visibility threshold in the viewport.
 * - `render_fallback` — `IntersectionObserver` was unavailable, so render was
 *   treated as exposure (AC-10).
 */
export type ExposureBasis = 'viewport' | 'render_fallback';

/** Per-element viewport-qualification options. */
export interface ExposureObserveOptions {
  /** Fraction of the element that must be visible (0–1). Default 0.5. */
  threshold?: number;
  /** `IntersectionObserver` root margin. Default `'0px'`. */
  rootMargin?: string;
  /** Dwell: how long the element must stay visible before it counts. Default 0. */
  minVisibleMs?: number;
}

/** Observes elements and reports when each first qualifies as exposed. */
export interface ExposureManager {
  /** True when the runtime can actually observe viewport visibility. */
  readonly supported: boolean;
  /**
   * Observe `el`; call `onExposed` once, the first time it qualifies. Returns an
   * unobserve function to call on unmount (before exposure fires).
   */
  observe(
    el: Element,
    options: ExposureObserveOptions,
    onExposed: (basis: ExposureBasis) => void,
  ): () => void;
  /** Tear down every shared observer. */
  disconnect(): void;
}

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_ROOT_MARGIN = '0px';

interface Tracked {
  onExposed: (basis: ExposureBasis) => void;
  minVisibleMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  fired: boolean;
}

interface Group {
  io: IntersectionObserver;
  tracked: Map<Element, Tracked>;
}

/**
 * Create an exposure manager. The SDK shares one instance across a page
 * ({@link exposureManager}); tests create their own for isolation.
 */
export function createExposureManager(): ExposureManager {
  const supported = typeof IntersectionObserver !== 'undefined';
  const groups = new Map<string, Group>();

  function settle(group: Group, el: Element, t: Tracked, basis: ExposureBasis): void {
    if (t.fired) return;
    t.fired = true;
    if (t.timer !== null) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    group.io.unobserve(el);
    group.tracked.delete(el);
    t.onExposed(basis);
  }

  function ensureGroup(threshold: number, rootMargin: string): Group {
    const key = `${threshold}|${rootMargin}`;
    const existing = groups.get(key);
    if (existing) return existing;

    const tracked = new Map<Element, Tracked>();
    const io = new IntersectionObserver(
      (entries) => {
        const group = groups.get(key);
        if (!group) return;
        for (const entry of entries) {
          const t = tracked.get(entry.target);
          if (!t || t.fired) continue;
          if (entry.isIntersecting) {
            // The observer is configured with `threshold`, so `isIntersecting`
            // already means the threshold is met. Fire now, or after dwell.
            if (t.minVisibleMs <= 0) {
              settle(group, entry.target, t, 'viewport');
            } else if (t.timer === null) {
              t.timer = setTimeout(() => settle(group, entry.target, t, 'viewport'), t.minVisibleMs);
            }
          } else if (t.timer !== null) {
            // Left the viewport before the dwell completed — reset.
            clearTimeout(t.timer);
            t.timer = null;
          }
        }
      },
      { threshold, rootMargin },
    );

    const group: Group = { io, tracked };
    groups.set(key, group);
    return group;
  }

  return {
    supported,

    observe(el, options, onExposed) {
      if (!supported) {
        // AC-10: no viewport observation → treat render as exposure. Async so
        // the ref assignment returns first, matching the real observer's timing.
        let cancelled = false;
        void Promise.resolve().then(() => {
          if (!cancelled) onExposed('render_fallback');
        });
        return () => {
          cancelled = true;
        };
      }

      const threshold = options.threshold ?? DEFAULT_THRESHOLD;
      const rootMargin = options.rootMargin ?? DEFAULT_ROOT_MARGIN;
      const group = ensureGroup(threshold, rootMargin);
      const t: Tracked = {
        onExposed,
        minVisibleMs: options.minVisibleMs ?? 0,
        timer: null,
        fired: false,
      };
      group.tracked.set(el, t);
      group.io.observe(el);

      return () => {
        if (t.fired) return;
        if (t.timer !== null) {
          clearTimeout(t.timer);
          t.timer = null;
        }
        group.io.unobserve(el);
        group.tracked.delete(el);
      };
    },

    disconnect() {
      for (const group of groups.values()) group.io.disconnect();
      groups.clear();
    },
  };
}

/**
 * Process-wide exposure manager. Sharing one instance lets placements requesting
 * the same config share a single `IntersectionObserver`.
 */
export const exposureManager: ExposureManager = createExposureManager();
