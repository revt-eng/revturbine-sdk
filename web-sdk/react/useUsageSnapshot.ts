'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RevTurbineUsageSnapshot } from '../customer-side';
import { useRevTurbine } from './useRevTurbine';

export interface UseUsageSnapshotResult {
  usage: RevTurbineUsageSnapshot;
  refresh: () => void;
}

export function useUsageSnapshot(): UseUsageSnapshotResult {
  const { sdk, isReady } = useRevTurbine();
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (isReady) refresh();
  }, [isReady, refresh]);

  const usage = useMemo(() => {
    void tick;
    if (!sdk || !isReady) return {};
    return sdk.getUsage();
  }, [sdk, isReady, tick]);

  return { usage, refresh };
}
