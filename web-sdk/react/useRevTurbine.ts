'use client';

import { createContext, useContext } from 'react';
import type { RevTurbineUserContext } from '../customer-side';
import { INIT_STATUS_OK, type RevTurbineInitStatus } from './init-status';

type RevTurbineContextValue = {
  sdk: import('../customer-side').RevTurbineCustomerSdk | null;
  isReady: boolean;
  error: string;
  /**
   * Initialization outcome, readable even when {@link sdk} is `null`.
   *
   * Every other diagnostic the SDK exposes is an instance method, so all of
   * them are unreachable when init failed — which is the failure that matters
   * most (plan 233 TASK-2). On failure this carries the phase, the underlying
   * message, and a non-empty `remediation` naming what to change.
   */
  initStatus: RevTurbineInitStatus;
  /**
   * The colour scheme currently painting placements — `'light'` or `'dark'`,
   * with `'system'` already resolved against `prefers-color-scheme`.
   *
   * Read-only: set it with the provider's `colorScheme` prop. Changing it
   * re-renders placements without re-initializing the SDK (plan 233 TASK-6).
   */
  colorScheme: 'light' | 'dark';
  /**
   * Update the SDK's user context. Merges the provided fields into the
   * existing context and triggers segment re-evaluation.
   *
   * This is the React-side wrapper around `sdk.setUserContext()`.
   */
  setContext: (context: RevTurbineUserContext) => void;
};

export const RevTurbineContext = createContext<RevTurbineContextValue>({
  sdk: null,
  isReady: false,
  error: '',
  initStatus: INIT_STATUS_OK,
  colorScheme: 'light',
  setContext: () => {},
});

export function useRevTurbine() {
  return useContext(RevTurbineContext);
}