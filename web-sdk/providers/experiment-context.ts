import type {
  DomainProviderResolutionInput,
  EffectiveUserContextResolution,
  ExperimentAssignmentProvider,
  ExperimentProviderState,
  ExperimentVariantNonAssignmentReason,
  ExperimentVariantSelection,
  UserContextSnapshot,
} from '@revt-eng/core';

/** Controls aggregation of customer-owned experiment adapters. */
export interface CompositeExperimentProviderOptions {
  /** Maximum time for one adapter resolution. Set to `0` to disable. */
  timeoutMs?: number;
}

function isNonEmptyHandle(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonAssignmentStatus(
  reason: ExperimentVariantNonAssignmentReason,
): Exclude<ExperimentVariantSelection['status'], 'assigned'> {
  if (reason === 'not_enrolled') return 'not_assigned';
  if (
    reason === 'provider_not_ready'
    || reason === 'provider_unavailable'
    || reason === 'provider_error'
    || reason === 'timeout'
    || reason === 'aborted'
  ) return 'unavailable';
  return 'unsupported';
}

function failureReason(error: object | undefined, signal: AbortSignal): ExperimentVariantNonAssignmentReason {
  if (signal.aborted) return 'aborted';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (typeof error === 'object' && error !== null && 'reason' in error) {
    const reason = Reflect.get(error, 'reason');
    if (reason === 'unknown_feature') return 'mapping_missing';
    if (reason === 'unexpected_variant') return 'unknown_variant';
    if (reason === 'invalid_variant') return 'unknown_variant';
    if (reason === 'client_not_ready') return 'provider_not_ready';
  }
  return 'provider_error';
}

function unavailableSelection(
  experimentHandle: string,
  reason: ExperimentVariantNonAssignmentReason,
  provider: ExperimentAssignmentProvider,
): ExperimentVariantSelection {
  return {
    status: nonAssignmentStatus(reason),
    experimentHandle,
    reason,
    ...(provider.providerHandle ? { providerHandle: provider.providerHandle } : {}),
    ...(provider.providerRevision !== undefined
      ? { providerRevision: provider.providerRevision }
      : {}),
  };
}

async function resolveWithTimeout(
  provider: ExperimentAssignmentProvider,
  input: DomainProviderResolutionInput,
  timeoutMs: number,
): Promise<ExperimentProviderState> {
  if (input.signal.aborted) {
    const error = new Error('Experiment provider resolution was aborted.');
    error.name = 'AbortError';
    throw error;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal.addEventListener('abort', abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    if (timeoutMs <= 0) return;
    timeout = setTimeout(() => {
      controller.abort();
      const error = new Error(`Experiment provider timed out after ${String(timeoutMs)}ms.`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      if (!input.signal.aborted) return;
      const error = new Error('Experiment provider resolution was aborted.');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve(provider.resolve({ ...input, signal: controller.signal })),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    input.signal.removeEventListener('abort', abort);
  }
}

/**
 * Combine customer-owned experiment adapters behind the registry's single
 * `experiments` domain. Overlapping declared ownership is rejected for the
 * affected handles instead of allowing registration order to choose a winner.
 */
export function createCompositeExperimentProvider(
  providers: readonly ExperimentAssignmentProvider[],
  options: CompositeExperimentProviderOptions = {},
): ExperimentAssignmentProvider {
  const owners = new Map<string, ExperimentAssignmentProvider[]>();
  for (const provider of providers) {
    for (const rawHandle of provider.ownedExperimentHandles ?? []) {
      const handle = rawHandle.trim();
      const current = owners.get(handle) ?? [];
      current.push(provider);
      owners.set(handle, current);
    }
  }

  const ownedExperimentHandles = [...owners.keys()].sort();

  return {
    domain: 'experiments',
    providerHandle: 'revturbine:experiment-context',
    ownedExperimentHandles,
    cacheTtlMs: Number.MAX_SAFE_INTEGER,
    get providerRevision(): string {
      return providers
        .map((provider, index) => `${String(index)}:${String(provider.providerRevision ?? '')}`)
        .join('|');
    },
    async resolve(input?: DomainProviderResolutionInput): Promise<ExperimentProviderState> {
      const fallbackController = new AbortController();
      const resolutionInput = input ?? {
        userContext: {},
        contextRevision: 'legacy',
        signal: fallbackController.signal,
      };
      const assignments: Record<string, string> = {};
      const selections: Record<string, ExperimentVariantSelection> = {};

      const timeoutMs = Math.max(0, options.timeoutMs ?? 5_000);
      const results = await Promise.allSettled(
        providers.map((provider) => resolveWithTimeout(provider, resolutionInput, timeoutMs)),
      );

      results.forEach((result, index) => {
        if (result.status === 'rejected') return;
        const provider = providers[index];
        if (!provider) return;
        const resolvedHandles = new Set([
          ...Object.keys(result.value.assignments),
          ...Object.keys(result.value.selections ?? {}),
        ]);
        for (const rawHandle of resolvedHandles) {
          const handle = rawHandle.trim();
          if (!handle) continue;
          const handleOwners = owners.get(handle) ?? [];
          if (!handleOwners.includes(provider)) handleOwners.push(provider);
          owners.set(handle, handleOwners);
        }
      });

      for (const [handle, handleOwners] of owners) {
        if (!isNonEmptyHandle(handle) || handleOwners.length < 2) continue;
        selections[handle] = {
          status: 'unsupported',
          experimentHandle: handle,
          reason: 'ownership_conflict',
        };
      }

      results.forEach((result, index) => {
        const provider = providers[index];
        if (!provider) return;
        const declaredHandles = provider.ownedExperimentHandles ?? [];

        if (result.status === 'rejected') {
          const reason = failureReason(result.reason, resolutionInput.signal);
          for (const handle of declaredHandles) {
            if (owners.get(handle)?.length !== 1) continue;
            selections[handle] = unavailableSelection(handle, reason, provider);
          }
          return;
        }

        const state = result.value;
        const handles = new Set([
          ...declaredHandles,
          ...Object.keys(state.assignments),
          ...Object.keys(state.selections ?? {}),
        ]);

        for (const rawHandle of handles) {
          const handle = rawHandle.trim();
          if (!isNonEmptyHandle(handle)) continue;
          if ((owners.get(handle)?.length ?? 0) > 1) continue;

          const suppliedSelection = state.selections?.[rawHandle];
          const variant = state.assignments[rawHandle];
          if (suppliedSelection) {
            selections[handle] = suppliedSelection;
            if (suppliedSelection.status === 'assigned') {
              assignments[handle] = suppliedSelection.variantHandle;
            }
            continue;
          }

          if (isNonEmptyHandle(variant)) {
            assignments[handle] = variant;
            selections[handle] = {
              status: 'assigned',
              experimentHandle: handle,
              variantHandle: variant,
              ...(provider.providerHandle ? { providerHandle: provider.providerHandle } : {}),
              ...(provider.providerRevision !== undefined
                ? { providerRevision: provider.providerRevision }
                : {}),
            };
          } else if (declaredHandles.includes(rawHandle)) {
            selections[handle] = unavailableSelection(handle, 'not_enrolled', provider);
          }
        }
      });

      return { assignments, selections };
    },
  };
}

/**
 * Materialize one ephemeral user context from caller context and normalized
 * provider outcomes. The caller-owned object is never mutated.
 */
export function composeEffectiveExperimentContext<TContext extends UserContextSnapshot>(
  callerContext: Readonly<TContext>,
  providerState: ExperimentProviderState | undefined,
  contextRevision: string,
): EffectiveUserContextResolution & { readonly userContext: Readonly<TContext> } {
  const assignments: Record<string, string> = {};
  const selections: Record<string, ExperimentVariantSelection> = {};

  for (const [rawHandle, rawVariant] of Object.entries(callerContext.experiments ?? {})) {
    const handle = rawHandle.trim();
    const variant = typeof rawVariant === 'string' ? rawVariant.trim() : '';
    if (!handle || !variant) {
      if (handle) {
        selections[handle] = {
          status: 'unsupported',
          experimentHandle: handle,
          reason: 'invalid_handle',
        };
      }
      continue;
    }
    assignments[handle] = variant;
    selections[handle] = {
      status: 'assigned',
      experimentHandle: handle,
      variantHandle: variant,
      providerHandle: 'user_context',
    };
  }

  for (const [rawHandle, providerSelection] of Object.entries(providerState?.selections ?? {})) {
    const handle = rawHandle.trim();
    if (!handle) continue;
    const callerVariant = assignments[handle];
    if (providerSelection.status === 'assigned' && callerVariant !== undefined) {
      if (callerVariant !== providerSelection.variantHandle) {
        delete assignments[handle];
        selections[handle] = {
          status: 'unsupported',
          experimentHandle: handle,
          reason: 'assignment_conflict',
          ...(providerSelection.providerHandle
            ? { providerHandle: providerSelection.providerHandle }
            : {}),
          ...(providerSelection.providerRevision !== undefined
            ? { providerRevision: providerSelection.providerRevision }
            : {}),
        };
      } else {
        selections[handle] = providerSelection;
      }
      continue;
    }
    if (callerVariant === undefined) {
      selections[handle] = providerSelection;
      if (providerSelection.status === 'assigned') {
        assignments[handle] = providerSelection.variantHandle;
      }
    }
  }

  for (const [rawHandle, rawVariant] of Object.entries(providerState?.assignments ?? {})) {
    const handle = rawHandle.trim();
    const variant = rawVariant.trim();
    if (!handle || !variant || selections[handle]) continue;
    assignments[handle] = variant;
    selections[handle] = {
      status: 'assigned',
      experimentHandle: handle,
      variantHandle: variant,
    };
  }

  const effectiveContext = {
    ...callerContext,
    ...(Object.keys(assignments).length > 0 ? { experiments: assignments } : { experiments: undefined }),
  };

  return {
    userContext: Object.freeze(effectiveContext),
    experimentSelections: Object.freeze(selections),
    contextRevision,
  };
}
