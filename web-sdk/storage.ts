/**
 * Storage abstraction for the RevTurbine web SDK.
 *
 * Re-exports core storage types and adds browser-specific implementations.
 */

import { isBrowser, InMemoryStorage } from '@revt-eng/core';
import type { RevTurbineStorage } from '@revt-eng/core';

// Re-export core types
export type { RevTurbineStorage } from '@revt-eng/core';
export { InMemoryStorage } from '@revt-eng/core';

/**
 * Wraps a browser `Storage` object (`localStorage` or `sessionStorage`)
 * with try/catch guards for quota and security-policy errors.
 */
export class BrowserStorage implements RevTurbineStorage {
  private readonly backend: Storage;
  constructor(backend: Storage) {
    this.backend = backend;
  }

  getItem(key: string): string | null {
    try {
      return this.backend.getItem(key);
    } catch {
      return null;
    }
  }
  setItem(key: string, value: string): void {
    try {
      this.backend.setItem(key, value);
    } catch {
      // Swallow quota / security-policy errors.
    }
  }
  removeItem(key: string): void {
    try {
      this.backend.removeItem(key);
    } catch {
      // Swallow.
    }
  }
}

/**
 * Resolve a persistent storage provider.
 *
 * Priority:
 * 1. Explicitly provided `storage` (customer override)
 * 2. `localStorage` when running in a browser
 * 3. In-memory fallback
 */
export function resolvePersistentStorage(storage?: RevTurbineStorage): RevTurbineStorage {
  if (storage) return storage;
  if (isBrowser()) {
    try {
      return new BrowserStorage(window.localStorage);
    } catch {
      // localStorage unavailable (e.g. sandboxed iframe).
    }
  }
  return new InMemoryStorage();
}

/**
 * Resolve a session-scoped storage provider.
 *
 * Priority:
 * 1. Explicitly provided `storage` (customer override)
 * 2. `sessionStorage` when running in a browser
 * 3. In-memory fallback
 */
export function resolveSessionStorage(storage?: RevTurbineStorage): RevTurbineStorage {
  if (storage) return storage;
  if (isBrowser()) {
    try {
      return new BrowserStorage(window.sessionStorage);
    } catch {
      // sessionStorage unavailable.
    }
  }
  return new InMemoryStorage();
}
