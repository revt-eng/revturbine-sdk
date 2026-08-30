'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EligiblePlan } from '../customer-side';
import { useRevTurbine } from './useRevTurbine';

export interface UsePlansResult {
  plans: EligiblePlan[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/** React access to the active user's public, segment-eligible plan catalog. */
export function usePlans(): UsePlansResult {
  const { sdk, isReady } = useRevTurbine();
  const [plans, setPlans] = useState<EligiblePlan[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!sdk || !isReady) {
      setPlans([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      setPlans(await sdk.getEligiblePlans());
    } catch (cause) {
      setPlans([]);
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

  return { plans, isLoading, error, refresh };
}
