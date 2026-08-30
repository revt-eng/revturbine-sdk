'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EligibleAddon } from '../customer-side';
import { useRevTurbine } from './useRevTurbine';

export interface UseAddonsResult {
  addons: EligibleAddon[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/** React access to the active user's public, segment-eligible add-on catalog. */
export function useAddons(): UseAddonsResult {
  const { sdk, isReady } = useRevTurbine();
  const [addons, setAddons] = useState<EligibleAddon[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!sdk || !isReady) {
      setAddons([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      setAddons(await sdk.getEligibleAddons());
    } catch (cause) {
      setAddons([]);
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setIsLoading(false);
    }
  }, [sdk, isReady]);

  useEffect(() => {
    void refresh();
    if (typeof sdk?.onUserContextChange !== 'function') return;
    return sdk.onUserContextChange(() => { void refresh(); });
  }, [sdk, refresh]);

  return { addons, isLoading, error, refresh };
}
