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

  // Plan 194 REQ-3: recompute when reported usage changes. The memo below keys
  // on `tick`, which only a manual `refresh()` used to move — so a meter
  // rendered from this hook stayed on the balance it first saw while
  // `update({ usage })` changed the decision underneath it.
  useEffect(() => {
    // Same tolerance as EntitlementGate.watchUserContext: consumers hand-roll
    // SDK doubles, and this method is new in this release. Throwing here would
    // break the host app's render.
    if (typeof sdk?.onUserContextChange !== 'function') return;
    return sdk.onUserContextChange(refresh);
  }, [sdk, refresh]);

  const usage = useMemo(() => {
    void tick;
    if (!sdk || !isReady) return {};
    return sdk.getUsage();
  }, [sdk, isReady, tick]);

  return { usage, refresh };
}
