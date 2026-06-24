import { useEffect, useMemo, useState } from 'react';
import { useRevTurbine } from '../react/useRevTurbine';
import { derivePlacementPersonalizationTokens } from './token-derivation';
import type { PersonalizationContext } from './types';

function extractTargetingTraitTokens(
  sdk: ReturnType<typeof useRevTurbine>['sdk'],
): PersonalizationContext {
  if (!sdk || typeof sdk.getTargeting !== 'function') return {};

  try {
    const targeting = sdk.getTargeting();
    const traits = targeting?.traits;
    if (!traits || typeof traits !== 'object' || Array.isArray(traits)) return {};

    const tokens: PersonalizationContext = {};
    for (const [key, value] of Object.entries(traits)) {
      if (typeof value === 'string' || typeof value === 'number') {
        tokens[key] = value;
      } else if (typeof value === 'boolean') {
        tokens[key] = value ? 'true' : 'false';
      }
    }
    return tokens;
  } catch {
    return {};
  }
}

function areTokenMapsEqual(a: PersonalizationContext, b: PersonalizationContext): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Options for deriving placement personalization tokens from provider state.
 */
export interface UsePlacementPersonalizationOptions {
  /** Optional explicit user ID. Falls back to provider default user ID when omitted. */
  userId?: string;
  /** Optional base personalization values merged before derived provider tokens. */
  personalization?: PersonalizationContext;
  /** Optional dependency trigger for re-resolving provider state. */
  refreshKey?: string | number;
}

/**
 * Derive placement personalization tokens from the SDK's registered providers.
 *
 * This hook resolves provider state through `sdk.providerRegistry.resolveAll()` so
 * token values honor provider strategies configured during SDK initialization.
 */
export function usePlacementPersonalization({
  userId,
  personalization,
  refreshKey,
}: UsePlacementPersonalizationOptions): PersonalizationContext {
  const { sdk, isReady } = useRevTurbine();
  const resolvedUserId = userId || (sdk ? sdk.getUserContext().user_id : undefined);
  const [derivedTokens, setDerivedTokens] = useState<PersonalizationContext>({});

  useEffect(() => {
    let cancelled = false;

    async function resolveTokens() {
      if (!sdk || !isReady) {
        if (!cancelled) {
          const fallback = {
            ...extractTargetingTraitTokens(sdk),
            ...(personalization ?? {}),
          };
          setDerivedTokens((previous) => (areTokenMapsEqual(previous, fallback) ? previous : fallback));
        }
        return;
      }

      try {
        const providers = await sdk.providerRegistry.resolveAll();
        if (cancelled) return;

        const next = derivePlacementPersonalizationTokens({
          userId: resolvedUserId,
          providers,
          base: personalization,
        });
        const merged = {
          ...extractTargetingTraitTokens(sdk),
          ...next,
        };
        setDerivedTokens((previous) => (areTokenMapsEqual(previous, merged) ? previous : merged));
      } catch {
        if (!cancelled) {
          const fallback = {
            ...extractTargetingTraitTokens(sdk),
            ...(personalization ?? {}),
          };
          setDerivedTokens((previous) => (areTokenMapsEqual(previous, fallback) ? previous : fallback));
        }
      }
    }

    void resolveTokens();

    return () => {
      cancelled = true;
    };
  }, [sdk, isReady, resolvedUserId, personalization, refreshKey]);

  return useMemo(() => derivedTokens, [derivedTokens]);
}
