import type { CtaResolver, CtaResolverContext, PlacementUiPath } from './types';

/**
 * Registry mapping CTA action types to resolver functions.
 *
 * Customers register a {@link CtaResolver} against an action type — typically a
 * tenant-defined custom action name surfaced through `parseUiPath` — so the
 * {@link PlacementRenderer} can dispatch a CTA click to dedicated logic instead
 * of the generic `onCtaClick` callback. Built-in action types may also be
 * overridden by registering a resolver for them.
 */
export class CtaResolverRegistry {
  private readonly resolvers = new Map<string, CtaResolver>();

  /**
   * Register a resolver for an action type. Re-registering the same type
   * replaces the previous resolver (and warns), matching the slot-type
   * registry's override semantics.
   */
  register(type: string, resolver: CtaResolver): void {
    if (this.resolvers.has(type)) {
      console.warn(`[RevTurbine] Replacing existing CTA resolver for action type "${type}".`);
    }
    this.resolvers.set(type, resolver);
  }

  /**
   * Remove the resolver for an action type.
   * Returns true if a resolver was registered and removed.
   */
  unregister(type: string): boolean {
    return this.resolvers.delete(type);
  }

  /** Look up the resolver registered for an action type, if any. */
  get(type: string): CtaResolver | undefined {
    return this.resolvers.get(type);
  }

  /** Whether a resolver is registered for an action type. */
  has(type: string): boolean {
    return this.resolvers.has(type);
  }

  /** Remove every registered resolver. */
  clear(): void {
    this.resolvers.clear();
  }
}

/** Singleton default CTA resolver registry. */
let defaultCtaResolverRegistry: CtaResolverRegistry | null = null;

/**
 * Get or create the default global CTA resolver registry. The
 * {@link PlacementRenderer} uses this when no `ctaResolvers` prop is supplied.
 */
export function getDefaultCtaResolverRegistry(): CtaResolverRegistry {
  if (!defaultCtaResolverRegistry) {
    defaultCtaResolverRegistry = new CtaResolverRegistry();
  }
  return defaultCtaResolverRegistry;
}

/**
 * Reset the default CTA resolver registry (useful for testing and for tearing
 * down tenant-specific resolvers).
 */
export function resetDefaultCtaResolverRegistry(): void {
  defaultCtaResolverRegistry = null;
}

/**
 * Register a {@link CtaResolver} on the default global registry.
 *
 * This is the ergonomic entry point for customers:
 *
 * ```ts
 * registerCtaResolver('connect_crm', (uiPath) => {
 *   openCrmModal(uiPath.url, uiPath.params);
 * });
 * ```
 */
export function registerCtaResolver(type: string, resolver: CtaResolver): void {
  getDefaultCtaResolverRegistry().register(type, resolver);
}

/**
 * Remove a resolver from the default global registry.
 * Returns true if a resolver was registered and removed.
 */
export function unregisterCtaResolver(type: string): boolean {
  return getDefaultCtaResolverRegistry().unregister(type);
}

/**
 * Dispatch a CTA activation: invoke the registered resolver for the action
 * type if one exists, otherwise fall back to the supplied callback.
 *
 * Returns `true` when a registered resolver handled the click, `false` when it
 * fell through to `fallback`. A registered resolver fully handles the action —
 * the fallback is not also called.
 */
export function dispatchCtaClick(
  uiPath: PlacementUiPath,
  context: CtaResolverContext,
  resolvers: CtaResolverRegistry,
  fallback?: (uiPath: PlacementUiPath) => void,
): boolean {
  const resolver = resolvers.get(uiPath.type);
  if (resolver) {
    resolver(uiPath, context);
    return true;
  }
  fallback?.(uiPath);
  return false;
}
