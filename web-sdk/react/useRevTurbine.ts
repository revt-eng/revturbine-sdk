import { createContext, useContext } from 'react';
import type { RevTurbineUserContext } from '../customer-side';

type RevTurbineContextValue = {
  sdk: import('../customer-side').RevTurbineCustomerSdk | null;
  isReady: boolean;
  error: string;
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
  setContext: () => {},
});

export function useRevTurbine() {
  return useContext(RevTurbineContext);
}
