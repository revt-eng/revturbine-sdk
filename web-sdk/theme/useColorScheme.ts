'use client';

import { useEffect, useState } from 'react';
import type { RevTurbineColorScheme } from './defaults';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Read the OS/browser preference once, safely.
 *
 * Returns `'light'` when `matchMedia` is unavailable — SSR, jsdom without the
 * shim, older embedded webviews. A scheme probe must never be the thing that
 * breaks a render.
 */
function systemScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Resolve a {@link RevTurbineColorScheme} to the concrete scheme to paint.
 *
 * `'system'` tracks `prefers-color-scheme` and keeps tracking it: a user
 * flipping their OS theme updates the resolved value without a remount, which
 * is the difference between following the system and sampling it once at init.
 *
 * @param preference - The requested scheme. `'system'` follows the OS.
 * @returns `'light'` or `'dark'`.
 * @public
 */
export function useResolvedColorScheme(preference: RevTurbineColorScheme): 'light' | 'dark' {
  const [systemValue, setSystemValue] = useState<'light' | 'dark'>(systemScheme);

  useEffect(() => {
    // Only subscribe while actually following the system — a fixed preference
    // has nothing to listen for.
    if (preference !== 'system') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    let query: MediaQueryList;
    try {
      query = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }

    const onChange = (event: MediaQueryListEvent) => {
      setSystemValue(event.matches ? 'dark' : 'light');
    };

    // Re-read on subscribe: the preference can change between the initial
    // useState and this effect, and that window is exactly where a missed
    // update becomes a permanently wrong palette.
    setSystemValue(query.matches ? 'dark' : 'light');

    // `addListener` is the deprecated form, still the only one in older Safari
    // and some embedded webviews the SDK ships into.
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    if (typeof query.addListener === 'function') {
      query.addListener(onChange);
      return () => query.removeListener(onChange);
    }
    return;
  }, [preference]);

  return preference === 'system' ? systemValue : preference;
}
