import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PRISM_CONFIG } from '../config/prism-config';
import { useDemo } from './DemoProvider';
import { burstRateFor, creditAllowanceFor, generationsLimitFor } from './derived';
import { makeImage, type GeneratedImage, type GenerateOutcome } from './image-engine';

interface StudioContextValue {
  gallery: GeneratedImage[];
  generate: (opts?: { premium?: boolean }) => GenerateOutcome;
  clear: () => void;
  generationsUsed: number;
  generationsLimit: number;
  creditBalance: number;
  creditLimit: number;
  burstLimit: number;
}

const StudioContext = createContext<StudioContextValue | null>(null);

/**
 * Holds the image-studio mechanic ABOVE the SDK boundary so the generated
 * gallery + rate-limit window survive the SDK remount that re-resolves slots
 * on each context change. The "Generate" loop consumes the `generations` usage
 * limit and the `burst_rate` rate limit, optionally spending a `credit` for a
 * premium style; usage + credit balances live in DemoState so the SDK
 * re-resolves the meters and threshold nudges.
 */
export function StudioProvider({ children }: { children: ReactNode }) {
  const { state, patch } = useDemo();
  const [gallery, setGallery] = useState<GeneratedImage[]>([]);
  const recentRef = useRef<number[]>([]);

  const generationsLimit = generationsLimitFor(PRISM_CONFIG, state.planHandle);
  const creditLimit = creditAllowanceFor(PRISM_CONFIG, state.planHandle);
  const burstLimit = burstRateFor(PRISM_CONFIG, state.planHandle);

  const generate = useCallback(
    (opts?: { premium?: boolean }): GenerateOutcome => {
      const premium = !!opts?.premium;
      const now = Date.now();
      // Sliding 60s window — client-simulated rate limit (no engine trigger exists).
      recentRef.current = recentRef.current.filter((t) => now - t < 60_000);
      if (recentRef.current.length >= burstLimit) return { ok: false, reason: 'rate_limited' };
      if (state.generationsUsed >= generationsLimit) return { ok: false, reason: 'usage_exhausted' };
      if (premium && state.creditBalance <= 0) return { ok: false, reason: 'no_credits' };

      recentRef.current.push(now);
      const image = makeImage(state.generationsUsed, premium);
      setGallery((prev) => [image, ...prev].slice(0, 9));
      patch({
        generationsUsed: state.generationsUsed + 1,
        ...(premium ? { creditBalance: Math.max(0, state.creditBalance - 1) } : {}),
      });
      return { ok: true, image };
    },
    [state.generationsUsed, state.creditBalance, generationsLimit, burstLimit, patch],
  );

  const clear = useCallback(() => setGallery([]), []);

  const value = useMemo<StudioContextValue>(
    () => ({
      gallery,
      generate,
      clear,
      generationsUsed: state.generationsUsed,
      generationsLimit,
      creditBalance: state.creditBalance,
      creditLimit,
      burstLimit,
    }),
    [gallery, generate, clear, state.generationsUsed, generationsLimit, state.creditBalance, creditLimit, burstLimit],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

/** Access the image-studio state + actions. Throws outside `StudioProvider`. */
export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio must be used within a StudioProvider');
  return ctx;
}
