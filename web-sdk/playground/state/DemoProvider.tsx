import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_DEMO_STATE,
  type DemoState,
  type PrismCustomTraits,
  type PrismTrialState,
} from './demo-state';

const STORAGE_KEY = 'revturbine:prism:demo-state';

interface DemoContextValue {
  state: DemoState;
  /** Replace the whole state. */
  setState: (next: DemoState) => void;
  /** Shallow-merge top-level fields. */
  patch: (partial: Partial<DemoState>) => void;
  /** Shallow-merge into `state.custom` (segmentation attributes). */
  patchCustom: (partial: Partial<PrismCustomTraits>) => void;
  /** Shallow-merge into `state.trial` (free/reverse trial simulation). */
  patchTrial: (partial: Partial<PrismTrialState>) => void;
  /** Reset to the default starting state. */
  reset: () => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

function loadInitialState(): DemoState {
  if (typeof window === 'undefined') return DEFAULT_DEMO_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DEMO_STATE;
    const parsed: Partial<DemoState> = JSON.parse(raw);
    return {
      ...DEFAULT_DEMO_STATE,
      ...parsed,
      custom: { ...DEFAULT_DEMO_STATE.custom, ...(parsed.custom ?? {}) },
      trial: { ...DEFAULT_DEMO_STATE.trial, ...(parsed.trial ?? {}) },
    };
  } catch {
    return DEFAULT_DEMO_STATE;
  }
}

/**
 * Holds the playground's simulated user state above the SDK boundary, so the
 * state survives the SDK remount that re-resolves placements on every context
 * change. Persists to localStorage so a demo session is repeatable.
 */
export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setStateRaw] = useState<DemoState>(loadInitialState);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* localStorage unavailable (private mode / SSR) — non-fatal for a demo. */
    }
  }, [state]);

  const setState = useCallback((next: DemoState) => setStateRaw(next), []);
  const patch = useCallback(
    (partial: Partial<DemoState>) => setStateRaw((prev) => ({ ...prev, ...partial })),
    [],
  );
  const patchCustom = useCallback(
    (partial: Partial<PrismCustomTraits>) =>
      setStateRaw((prev) => ({ ...prev, custom: { ...prev.custom, ...partial } })),
    [],
  );
  const patchTrial = useCallback(
    (partial: Partial<PrismTrialState>) =>
      setStateRaw((prev) => ({ ...prev, trial: { ...prev.trial, ...partial } })),
    [],
  );
  const reset = useCallback(() => setStateRaw(DEFAULT_DEMO_STATE), []);

  const value = useMemo<DemoContextValue>(
    () => ({ state, setState, patch, patchCustom, patchTrial, reset }),
    [state, setState, patch, patchCustom, patchTrial, reset],
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

/** Access the playground demo state + mutators. Throws outside `DemoProvider`. */
export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo must be used within a DemoProvider');
  return ctx;
}
