import type { RevTurbineTheme, RevTurbineThemeInput } from './types';
import { mergeTheme } from './defaults';
import type { RevTurbineStorage } from '../storage';
import { resolvePersistentStorage } from '../storage';

const THEME_STORAGE_PREFIX = 'revturbine:theme';

function storageKey(tenantId: string): string {
  return `${THEME_STORAGE_PREFIX}:${tenantId}`;
}

/** Read a previously-persisted theme. */
function readPersistedTheme(tenantId: string, storage: RevTurbineStorage): RevTurbineThemeInput | null {
  try {
    const raw = storage.getItem(storageKey(tenantId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as RevTurbineThemeInput;
  } catch {
    return null;
  }
}

/** Persist a theme input for offline / fast-load use. */
function persistTheme(tenantId: string, input: RevTurbineThemeInput, storage: RevTurbineStorage): void {
  try {
    storage.setItem(storageKey(tenantId), JSON.stringify(input));
  } catch {
    // Swallow quota/serialization issues.
  }
}

/** Clear persisted theme (useful on identity reset). */
export function clearPersistedTheme(tenantId: string, storage?: RevTurbineStorage): void {
  const resolved = storage ?? resolvePersistentStorage();
  try {
    resolved.removeItem(storageKey(tenantId));
  } catch {
    // Swallow.
  }
}

export interface ThemeLoaderOptions {
  /** RevTurbine tenant identifier. */
  tenantId: string;
  /** Base URL of the RevTurbine API Edge. */
  endpoint: string;
  /** API key for authentication. */
  apiKey: string;
  /** Optional storage provider. Falls back to localStorage in browser, in-memory on server. */
  storage?: RevTurbineStorage;
  /**
   * The launched Playbook's theme, used as the BASE that fetched overrides
   * merge over (plan 184). Supplying it means a partial override from the
   * control plane refines the Playbook's theme instead of replacing it.
   */
  base?: RevTurbineThemeInput;
  /**
   * Called with the RAW override — the persisted copy on the fast path, then
   * the freshly-fetched one — or `null` when there is no override.
   *
   * The resolved {@link RevTurbineTheme} is already merged with defaults, so it
   * can't tell "the API supplied branding" from "nothing was fetched". Callers
   * that must distinguish those — `getBranding()`, which reports which ladder
   * rung won — need this unmerged value (plan 184).
   */
  onOverride?: (override: RevTurbineThemeInput | null) => void;
}

/**
 * Load the tenant's theme:
 * 1. Return the locally-persisted theme immediately (fast path).
 * 2. Fetch the latest from the API in the background.
 * 3. If the remote version differs, update local storage and return the new theme.
 *
 * Returns a resolved {@link RevTurbineTheme} (merged with defaults).
 * Also provides an `onUpdate` callback callers can use to react to
 * background refreshes.
 */
export async function loadTheme(
  opts: ThemeLoaderOptions,
  onUpdate?: (theme: RevTurbineTheme) => void,
): Promise<RevTurbineTheme> {
  const { tenantId, endpoint, apiKey, base } = opts;
  const storage = opts.storage ?? resolvePersistentStorage();

  // Fast path: use persisted theme while we fetch. Layered over the Playbook's
  // theme so an override that sets only a few tokens refines the base rather
  // than replacing it (plan 184).
  const persisted = readPersistedTheme(tenantId, storage);
  const localTheme = mergeTheme({ ...base, ...persisted });
  opts.onOverride?.(persisted);

  // Fire off background fetch — don't block the caller.
  fetchRemoteTheme(endpoint, tenantId, apiKey).then((remote) => {
    if (!remote) return;
    // Skip update if versions match.
    if (persisted?.version && remote.version === persisted.version) return;

    persistTheme(tenantId, remote, storage);
    opts.onOverride?.(remote);
    onUpdate?.(mergeTheme({ ...base, ...remote }));
  }).catch(() => {
    // Network failures are non-fatal; we already have the local theme.
  });

  return localTheme;
}

/**
 * Fetch the theme from the API edge.
 * Returns the raw partial theme or null on failure.
 */
async function fetchRemoteTheme(
  endpoint: string,
  tenantId: string,
  apiKey: string,
): Promise<RevTurbineThemeInput | null> {
  const base = endpoint.replace(/\/$/, '');
  const rid = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const response = await fetch(`${base}/api/sdk/theme`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'x-tenant-id': tenantId,
      'x-request-id': rid,
    },
  });

  if (!response.ok) return null;

  const body = await response.json();
  if (typeof body !== 'object' || body === null) return null;

  return body as RevTurbineThemeInput;
}
