import type { RevTurbineTheme, RevTurbineThemeInput } from './types';
import { baseThemeForScheme, mergeTheme } from './defaults';
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

/**
 * A short, stable, non-reversible tag for a key (FNV-1a, 32-bit). Used to
 * scope the persisted theme per public key, so two keys on one origin never
 * share a cache entry and the key itself is not written into storage keys.
 */
function keyScope(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `key-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

let apiKeyIgnoredWarned = false;

/** Warn once that `loadTheme({ apiKey })` no longer sends that key. */
function warnApiKeyIgnored(): void {
  if (apiKeyIgnoredWarned) return;
  apiKeyIgnoredWarned = true;
  console.warn(
    '[RevTurbine] loadTheme() ignores `apiKey`: it is the secret server key and is never sent. '
      + 'Pass your public key as `publicKey` to fetch the theme.',
  );
}

export interface ThemeLoaderOptions {
  /**
   * Your **public key** — the only credential the theme API accepts
   * (BL-0477). The control plane resolves the tenant from it; a server key is
   * refused with 403. Without a key nothing is fetched and the persisted /
   * `base` theme is returned.
   */
  publicKey?: string;
  /**
   * @deprecated **Ignored since 0.12.2.** Use {@link ThemeLoaderOptions.publicKey}.
   * `apiKey` names the secret server key everywhere else in the SDK, so the
   * theme loader never sends it: a call that supplies only `apiKey` fetches
   * nothing (and warns once) and returns the persisted / `base` theme. Kept so
   * existing callers still compile.
   */
  apiKey?: string;
  /**
   * @deprecated No longer sent (BL-0477): the public key alone identifies the
   * tenant (D-49). Kept so existing callers still compile.
   */
  tenantId?: string;
  /**
   * Namespace for the locally persisted theme. Defaults to a scope derived
   * from the public key, so two keys on one origin never share an entry.
   */
  storageScope?: string;
  /** Base URL of the RevTurbine API Edge. */
  endpoint: string;
  /** Optional storage provider. Falls back to localStorage in browser, in-memory on server. */
  storage?: RevTurbineStorage;
  /**
   * The launched Playbook's theme, used as the BASE that fetched overrides
   * merge over (plan 184). Supplying it means a partial override from the
   * control plane refines the Playbook's theme instead of replacing it.
   */
  base?: RevTurbineThemeInput;
  /** Palette used for tokens absent from the base and fetched override. */
  colorScheme?: 'light' | 'dark';
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
  const { endpoint, base } = opts;
  // BL-0477: the public key is the ONLY credential read. `apiKey` is never
  // sent — whatever it holds — because everywhere else it is the secret
  // server key, and a theme fetch runs in browsers.
  const publicKey = opts.publicKey?.trim() || undefined;
  if (!publicKey && opts.apiKey?.trim()) warnApiKeyIgnored();
  const scope = opts.storageScope ?? (publicKey ? keyScope(publicKey) : 'local');
  const storage = opts.storage ?? resolvePersistentStorage();

  // Fast path: use persisted theme while we fetch. Layered over the Playbook's
  // theme so an override that sets only a few tokens refines the base rather
  // than replacing it (plan 184).
  const persisted = readPersistedTheme(scope, storage);
  const palette = baseThemeForScheme(opts.colorScheme ?? 'light');
  const localTheme = mergeTheme({ ...base, ...persisted }, palette);
  opts.onOverride?.(persisted);

  // BL-0477: no key, no request — never a placeholder bearer.
  if (!publicKey) return localTheme;

  // Fire off background fetch — don't block the caller.
  fetchRemoteTheme(endpoint, publicKey).then((remote) => {
    if (!remote) return;
    // Skip update if versions match.
    if (persisted?.version && remote.version === persisted.version) return;

    persistTheme(scope, remote, storage);
    opts.onOverride?.(remote);
    onUpdate?.(mergeTheme({ ...base, ...remote }, palette));
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
  publicKey: string,
): Promise<RevTurbineThemeInput | null> {
  const base = endpoint.replace(/\/$/, '');
  const rid = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // BL-0477: the public key is the only credential and names the tenant; no
  // `x-tenant-id` is sent.
  const response = await fetch(`${base}/api/sdk/theme`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${publicKey}`,
      'x-request-id': rid,
    },
  });

  if (!response.ok) return null;

  const body = await response.json();
  if (typeof body !== 'object' || body === null) return null;

  return body as RevTurbineThemeInput;
}
