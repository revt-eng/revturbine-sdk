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
import { burstRateFor, creditAllowanceFor, effectivePlanHandle, generationsLimitFor, overagePriceFor } from './derived';
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

  // A reverse trial lifts the usage cap and rate limit to the premium plan's
  // (it grants Pro entitlements without changing the plan); credits are not part
  // of the trial grant, so they stay on the actual plan.
  const effectivePlan = effectivePlanHandle(state);
  const generationsLimit = generationsLimitFor(PRISM_CONFIG, effectivePlan);
  const creditLimit = creditAllowanceFor(PRISM_CONFIG, state.planHandle);
  const burstLimit = burstRateFor(PRISM_CONFIG, effectivePlan);

  const generate = useCallback(
    (opts?: { premium?: boolean }): GenerateOutcome => {
      const premium = !!opts?.premium;
      const now = Date.now();
      // Sliding 60s window — client-simulated rate limit (no engine trigger exists).
      recentRef.current = recentRef.current.filter((t) => now - t < 60_000);
      if (recentRef.current.length >= burstLimit) return { ok: false, reason: 'rate_limited' };
      // At the cap: plans that allow overage keep generating (billed per image);
      // plans without it (Free) hard-block and surface the usage gate.
      const allowsOverage = !!overagePriceFor(PRISM_CONFIG, state.planHandle);
      if (state.generationsUsed >= generationsLimit && !allowsOverage)
        return { ok: false, reason: 'usage_exhausted' };
      if (premium && state.creditBalance <= 0) return { ok: false, reason: 'no_credits' };

      recentRef.current.push(now);
      const image = makeImage(state.generationsUsed, premium);
      // Keep the 24 most-recent tiles (a 3×8 grid); the usage count keeps
      // climbing past this and the canvas shows an "and N more" caption.
      setGallery((prev) => [image, ...prev].slice(0, 24));
      patch({
        generationsUsed: state.generationsUsed + 1,
        ...(premium ? { creditBalance: Math.max(0, state.creditBalance - 1) } : {}),
      });
      return { ok: true, image };
    },
    [state.generationsUsed, state.creditBalance, generationsLimit, burstLimit, patch],
  );

  // Clear the studio: the generated gallery AND the rate-limit window, so a
  // reset / journey change starts clean (the burst history must not carry over).
  const clear = useCallback(() => {
    setGallery([]);
    recentRef.current = [];
  }, []);

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
