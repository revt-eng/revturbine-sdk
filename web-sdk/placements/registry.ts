import { DEFAULT_TEMPLATE_COMPONENT_TYPES } from '@revt-eng/schema';
import type { RevTurbineComponentType, PlacementOutput } from '../customer-side';
import type {
  PlacementSlotType,
  PlacementSlotProps,
  RegisterPlacementSlotTypeOptions,
  PersonalizationContext,
  ResolvedContent,
  PlacementUiPath,
  PlacementPromotion,
} from './types';
/**
 * Keys {@link parseUiPath} lifts onto typed `PlacementUiPath` fields. Every
 * other key in a `cta_path` record is collected into `params`.
 */
const UI_PATH_TYPED_KEYS: ReadonlySet<string> = new Set([
  'type',
  'plan_handle',
  'promotion_id',
  'placement_handle',
  'url',
  'tour_id',
]);

function registrationComponentType(
  options: Pick<RegisterPlacementSlotTypeOptions, 'componentType' | 'surfaceType'>,
): RevTurbineComponentType {
  const componentType = options.componentType ?? options.surfaceType;
  if (!componentType) {
    throw new Error('[RevTurbine] Placement component registration requires componentType.');
  }
  return componentType;
}

/**
 * Registry for placement slot types.
 *
 * Manages built-in and custom placement renderers. The registry resolves
 * a PlacementOutput to the best matching slot type based on surface type
 * and template, then provides the component and resolved props for rendering.
 */
export class PlacementTypeRegistry {
  private readonly types = new Map<string, PlacementSlotType>();
  private readonly componentIndex = new Map<RevTurbineComponentType, string[]>();

  /**
   * Register a placement slot type. If a type with the same id already exists,
   * it is replaced (allows customer overrides of built-in types).
   */
  register<P extends PlacementSlotProps>(options: RegisterPlacementSlotTypeOptions<P>): void {
    const componentType = registrationComponentType(options);
    const existingType = this.types.get(options.id);
    if (existingType) {
      console.warn(
        `[RevTurbine] Replacing existing placement slot type id ${options.id}.`,
        {
          previousComponentType: existingType.componentType,
          nextComponentType: componentType,
        },
      );
    }

    const slotType: PlacementSlotType<P> = {
      ...options,
      componentType,
      priority: options.priority ?? 0,
      renderedFields: options.renderedFields ?? [],
      accepts: options.accepts ?? ((output) => output.surface.type === componentType),
    };

    this.types.set(slotType.id, slotType as PlacementSlotType);

    const existing = this.componentIndex.get(slotType.componentType) ?? [];
    if (!existing.includes(slotType.id)) {
      existing.push(slotType.id);
      this.componentIndex.set(slotType.componentType, existing);
    }
  }

  /**
   * Unregister a placement slot type by id.
   * Returns true if the type was found and removed.
   */
  unregister(id: string): boolean {
    const slotType = this.types.get(id);
    if (!slotType) return false;

    this.types.delete(id);

    const existing = this.componentIndex.get(slotType.componentType);
    if (existing) {
      const filtered = existing.filter((typeId) => typeId !== id);
      if (filtered.length > 0) {
        this.componentIndex.set(slotType.componentType, filtered);
      } else {
        this.componentIndex.delete(slotType.componentType);
      }
    }

    return true;
  }

  /**
   * Look up a slot type by its id.
   */
  get(id: string): PlacementSlotType | undefined {
    return this.types.get(id);
  }

  /**
   * Resolve the best matching slot type for a placement output.
   *
   * Resolution order:
   * 1. If the output's surface.template matches a registered type id, use it
   * 2. Find all types for the output's surface.type, sort by priority descending,
   *    and pick the first whose `accepts()` returns true
   * 3. Fall back to a 'custom' type if registered
   * 4. Return undefined if no match
   */
  resolve(output: PlacementOutput): PlacementSlotType | undefined {
    // 1. Direct template match
    if (output.surface.template) {
      const byTemplate = this.types.get(output.surface.template);
      if (byTemplate) return byTemplate;

      const mappedType = DEFAULT_TEMPLATE_COMPONENT_TYPES[
        output.surface.template as keyof typeof DEFAULT_TEMPLATE_COMPONENT_TYPES
      ];
      if (mappedType && mappedType !== output.surface.type) return undefined;
    }

    // 2. Surface type match with accepts predicate, sorted by priority desc
    const candidateIds = this.componentIndex.get(output.surface.type) ?? [];
    const candidates = candidateIds
      .map((id) => this.types.get(id))
      .filter((t): t is PlacementSlotType => t != null)
      .sort((a, b) => b.priority - a.priority);

    for (const candidate of candidates) {
      if (candidate.accepts?.(output)) return candidate;
    }

    // 3. Fallback to generic custom type
    return this.types.get('custom');
  }

  /**
   * List all registered slot types.
   */
  listAll(): PlacementSlotType[] {
    return Array.from(this.types.values());
  }

  /**
   * List slot types for a specific surface type.
   */
  listByComponentType(componentType: RevTurbineComponentType): PlacementSlotType[] {
    const ids = this.componentIndex.get(componentType) ?? [];
    return ids.map((id) => this.types.get(id)).filter(Boolean) as PlacementSlotType[];
  }

  /** @deprecated Use {@link listByComponentType}. */
  listBySurfaceType(componentType: RevTurbineComponentType): PlacementSlotType[] {
    return this.listByComponentType(componentType);
  }

  /**
   * Check if a slot type id is registered.
   */
  has(id: string): boolean {
    return this.types.has(id);
  }
}

/**
 * Resolve personalization tokens in a string value.
 * Tokens use the `{{token_name}}` format.
 */
export function resolveTokens(template: string, context: PersonalizationContext): string {
  const tokenAliases: Record<string, string> = {
    current_usage: 'usage_current',
    current_limit: 'usage_limit',
    remaining_usage: 'usage_remaining',
  };

  const coerceNumber = (value: unknown): number | undefined => { // sdk-ok: boundary-parse
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };

  const deriveUsageRemaining = (token: string): number | undefined => {
    const suffix = '_usage_remaining';

    if (token === 'usage_remaining') {
      const current = coerceNumber(context.usage_current ?? context.current_usage);
      const limit = coerceNumber(context.usage_limit);
      if (current !== undefined && limit !== undefined) {
        return Math.max(0, limit - current);
      }
      return undefined;
    }

    if (!token.endsWith(suffix)) return undefined;

    const usageUnit = token.slice(0, -suffix.length);
    if (!usageUnit) return undefined;

    const current = coerceNumber(context[`${usageUnit}_usage_current`]);
    const limit = coerceNumber(context[`${usageUnit}_usage_limit`]);

    if (current === undefined || limit === undefined) return undefined;
    return Math.max(0, limit - current);
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => {
    const canonicalToken = tokenAliases[token] ?? token;
    const value = context[canonicalToken];
    if (value != null) return String(value);

    const derived = deriveUsageRemaining(canonicalToken);
    return derived != null ? String(derived) : `{{${token}}}`;
  });
}

/**
 * Resolve all personalization tokens in a content object.
 */
export function resolveContent(
  content: Record<string, unknown>, // sdk-ok: boundary-parse
  context: PersonalizationContext,
): ResolvedContent {
  const resolved: ResolvedContent = {};

  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string') {
      resolved[key] = resolveTokens(value, context);
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * Parse a `cta_path` (or legacy `ui_path`) record from a placement output into
 * a typed {@link PlacementUiPath}.
 *
 * Built-in fields (`url`, `plan_handle`, …) are lifted onto typed properties.
 * The `type` is preserved verbatim for any non-empty string — including
 * tenant-defined custom action names — so a registered {@link CtaResolver} can
 * key on it; only an absent or non-string `type` defaults to `'dismiss'`. Every
 * remaining key is collected into `params` for custom resolvers to read.
 */
export function parseUiPath(raw: Record<string, unknown>): PlacementUiPath { // sdk-ok: boundary-parse
  const type: PlacementUiPath['type'] =
    typeof raw.type === 'string' && raw.type.length > 0 ? raw.type : 'dismiss';

  const params: Record<string, unknown> = {}; // sdk-ok: boundary-parse
  for (const [key, value] of Object.entries(raw)) {
    if (!UI_PATH_TYPED_KEYS.has(key)) params[key] = value;
  }

  return {
    type,
    plan_handle: typeof raw.plan_handle === 'string' ? raw.plan_handle : undefined,
    promotion_id: typeof raw.promotion_id === 'string' ? raw.promotion_id : undefined,
    placement_handle: typeof raw.placement_handle === 'string' ? raw.placement_handle : undefined,
    url: typeof raw.url === 'string' ? raw.url : undefined,
    tour_id: typeof raw.tour_id === 'string' ? raw.tour_id : undefined,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/**
 * Parse a promotion record from a placement output.
 */
export function parsePromotion(raw?: Record<string, unknown>): PlacementPromotion | undefined { // sdk-ok: boundary-parse
  if (!raw) return undefined;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : undefined,
    discount: typeof raw.discount === 'string' ? raw.discount : undefined,
    type: typeof raw.type === 'string' ? raw.type : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
  };
}

/** Singleton default registry. */
let defaultRegistry: PlacementTypeRegistry | null = null;
let placementRegistrySeed: ((registry: PlacementTypeRegistry) => void) | null = null;
let defaultRegistrySeedApplied = false;

/**
 * Install the seed applied to every SDK-created registry — the default
 * singleton (on creation, or immediately if it already exists unseeded) and
 * each SDK instance's `placementTypeRegistry`.
 *
 * The React entry installs the built-in slot components through this hook
 * (`placements/install-builtins.ts`); the registry itself must not import
 * them so the headless entry stays free of the React component graph.
 * Internal wiring — not re-exported from the package entries.
 */
export function setPlacementRegistrySeed(seed: (registry: PlacementTypeRegistry) => void): void {
  placementRegistrySeed = seed;
  if (defaultRegistry && !defaultRegistrySeedApplied) {
    defaultRegistrySeedApplied = true;
    seed(defaultRegistry);
  }
}

/**
 * Apply the installed seed (if any) to a freshly created registry. Used by
 * the SDK constructor for its per-instance registry. Internal wiring.
 */
export function applyPlacementRegistrySeed(registry: PlacementTypeRegistry): void {
  placementRegistrySeed?.(registry);
}

/**
 * Get or create the default global placement type registry.
 *
 * On the React entry the registry comes pre-seeded with the built-in slot
 * types; on the headless entry it starts empty (headless consumers register
 * their own types via {@link PlacementTypeRegistry.register}).
 */
export function getDefaultRegistry(): PlacementTypeRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new PlacementTypeRegistry();
    if (placementRegistrySeed) {
      defaultRegistrySeedApplied = true;
      placementRegistrySeed(defaultRegistry);
    }
  }
  return defaultRegistry;
}

/**
 * Reset the default registry (useful for testing).
 */
export function resetDefaultRegistry(): void {
  defaultRegistry = null;
  defaultRegistrySeedApplied = false;
}
