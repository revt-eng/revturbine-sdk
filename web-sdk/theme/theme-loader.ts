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
  const { tenantId, endpoint, apiKey } = opts;
  const storage = opts.storage ?? resolvePersistentStorage();

  // Fast path: use persisted theme while we fetch.
  const persisted = readPersistedTheme(tenantId, storage);
  const localTheme = mergeTheme(persisted);

  // Fire off background fetch — don't block the caller.
  fetchRemoteTheme(endpoint, tenantId, apiKey).then((remote) => {
    if (!remote) return;
    // Skip update if versions match.
    if (persisted?.version && remote.version === persisted.version) return;

    persistTheme(tenantId, remote, storage);
    onUpdate?.(mergeTheme(remote));
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
