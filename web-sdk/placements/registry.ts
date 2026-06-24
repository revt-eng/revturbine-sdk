import type { RevTurbineSurfaceType, PlacementOutput } from '../customer-side';
import type {
  PlacementSlotType,
  PlacementSlotProps,
  RegisterPlacementSlotTypeOptions,
  PersonalizationContext,
  ResolvedContent,
  PlacementUiPath,
  PlacementPromotion,
} from './types';
import { registerBuiltinSlotTypes } from './builtin';

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

/**
 * Registry for placement slot types.
 *
 * Manages built-in and custom placement renderers. The registry resolves
 * a PlacementOutput to the best matching slot type based on surface type
 * and template, then provides the component and resolved props for rendering.
 */
export class PlacementTypeRegistry {
  private readonly types = new Map<string, PlacementSlotType>();
  private readonly surfaceIndex = new Map<RevTurbineSurfaceType, string[]>();

  /**
   * Register a placement slot type. If a type with the same id already exists,
   * it is replaced (allows customer overrides of built-in types).
   */
  register<P extends PlacementSlotProps>(options: RegisterPlacementSlotTypeOptions<P>): void {
    const existingType = this.types.get(options.id);
    if (existingType) {
      console.warn(
        `[RevTurbine] Replacing existing placement slot type id ${options.id}.`,
        {
          previousSurfaceType: existingType.surfaceType,
          nextSurfaceType: options.surfaceType,
        },
      );
    }

    const slotType: PlacementSlotType<P> = {
      ...options,
      priority: options.priority ?? 0,
      accepts: options.accepts ?? ((output) => output.surface.type === options.surfaceType),
    };

    this.types.set(slotType.id, slotType as PlacementSlotType);

    const existing = this.surfaceIndex.get(slotType.surfaceType) ?? [];
    if (!existing.includes(slotType.id)) {
      existing.push(slotType.id);
      this.surfaceIndex.set(slotType.surfaceType, existing);
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

    const existing = this.surfaceIndex.get(slotType.surfaceType);
    if (existing) {
      const filtered = existing.filter((typeId) => typeId !== id);
      if (filtered.length > 0) {
        this.surfaceIndex.set(slotType.surfaceType, filtered);
      } else {
        this.surfaceIndex.delete(slotType.surfaceType);
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
    }

    // 2. Surface type match with accepts predicate, sorted by priority desc
    const candidateIds = this.surfaceIndex.get(output.surface.type) ?? [];
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
  listBySurfaceType(surfaceType: RevTurbineSurfaceType): PlacementSlotType[] {
    const ids = this.surfaceIndex.get(surfaceType) ?? [];
    return ids.map((id) => this.types.get(id)).filter(Boolean) as PlacementSlotType[];
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

/**
 * Get or create the default global placement type registry.
 */
export function getDefaultRegistry(): PlacementTypeRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new PlacementTypeRegistry();
    registerBuiltinSlotTypes(defaultRegistry);
  }
  return defaultRegistry;
}

/**
 * Reset the default registry (useful for testing).
 */
export function resetDefaultRegistry(): void {
  defaultRegistry = null;
}
