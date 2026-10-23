import { normalizeConfigArtifactOrThrow, type Playbook } from '@revturbine/sdk/headless';
import { z } from 'zod';

// Compatibility is pinned to @revturbine/sdk 0.12.4. Review these on upgrade.
const READABLE_SCHEMA_MIN = 11;
const READABLE_SCHEMA_MAX = 18;
const REFRESH_MS = 60_000;
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;

const artifactRef = z.object({
  url: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byte_length: z.number().int().nonnegative(),
  brotli_byte_length: z.number().int().nonnegative().optional(),
  gzip_byte_length: z.number().int().nonnegative().optional(),
}).strict();

const manifestSchema = z.object({
  manifest_version: z.literal('1.0.0'),
  tenant_id: z.string(),
  config_version: z.string(),
  schema_version: z.number().int().min(READABLE_SCHEMA_MIN).max(READABLE_SCHEMA_MAX),
  runtime_abi: z.literal(2),
  active: artifactRef,
  standby: artifactRef.optional(),
  previous: artifactRef.optional(),
  not_before: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
  rollback_to: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  signature: z.object({
    alg: z.literal('ed25519'), key_id: z.string().min(1),
    sig: z.string().regex(/^[A-Za-z0-9_-]+$/),
  }).strict().optional(),
}).strict().refine(m => Date.parse(m.not_before) <= Date.parse(m.expires_at));

const payloadEnvelope = z.object({
  tenant_id: z.string().min(1),
  environment_id: z.string().min(1),
  bundle_schema_version: z.number().int().min(READABLE_SCHEMA_MIN).max(READABLE_SCHEMA_MAX),
  bundle_min_readable_schema_version: z.number().int().nonnegative().optional(),
}).passthrough().refine(p =>
  (p.bundle_min_readable_schema_version ?? p.bundle_schema_version) <= p.bundle_schema_version);

/** An immutable admitted Playbook with its integrity and freshness receipt. */
export interface PlaybookSnapshot {
  readonly playbook: Playbook;
  readonly sha256: string;
  readonly configVersion: string;
  readonly expiresAt: number;
  readonly refreshAt: number;
}

/** Trusted deployment configuration and optional deterministic transport/clock. */
export interface PlaybookCacheOptions {
  endpoint: string;
  apiKey: string;
  tenantId: string;
  environmentId: string;
  allowedCdnOrigins: readonly string[];
  fetch?: typeof fetch; // Injection points for deterministic tests.
  now?: () => number;
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

/** One immutable Playbook cache per warm instance; never cache a user's SDK here. */
export function createPlaybookCache(options: PlaybookCacheOptions) {
  const { apiKey, tenantId, environmentId } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const endpoint = new URL(options.endpoint.replace(/\/+$/, ''));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !apiKey || !tenantId || !environmentId) {
    throw new Error('Invalid Playbook cache configuration');
  }
  const allowed = new Set(options.allowedCdnOrigins.map(origin => {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid CDN origin');
    return url.origin;
  }));
  let snapshot: PlaybookSnapshot | undefined;
  let inFlight: Promise<PlaybookSnapshot> | undefined;
  let retryAt = 0;
  let lastError: unknown;

  function deliveryUrl(raw: string): string {
    // RevTurbine's /api delivery paths are relative to the endpoint's /app prefix.
    const base = endpoint.toString().replace(/\/+$/, '');
    const prefix = endpoint.pathname.replace(/\/+$/, '');
    const path = raw.startsWith('/') && !raw.startsWith('//') && prefix &&
      raw !== prefix && !raw.startsWith(`${prefix}/`) ? `${prefix}${raw}` : raw;
    const url = new URL(path, `${base}/`);
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.has(url.origin)) {
      throw new Error('Unapproved Playbook delivery origin');
    }
    return url.toString();
  }

  async function readBytes(url: string, limit: number, bearer?: string): Promise<Uint8Array<ArrayBuffer>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetcher(url, {
        headers: { accept: 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        // Revalidate the launch pointer; let immutable CDN objects use HTTP caching.
        cache: bearer ? 'no-store' : 'default', credentials: 'omit', redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Playbook delivery HTTP ${response.status}`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) { controller.abort(); throw new Error('Playbook delivery size limit exceeded'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    } finally { clearTimeout(timer); }
  }

  function checkWindow(manifest: z.infer<typeof manifestSchema>, at: number): void {
    // Match the SDK's bounded opening-clock skew; expiration remains strict.
    if (Date.parse(manifest.not_before) > at + 60_000 || Date.parse(manifest.expires_at) <= at) {
      throw new Error('Playbook manifest is outside its validity window');
    }
  }

  async function refresh(): Promise<PlaybookSnapshot> {
    const bootstrapUrl = `${endpoint.toString().replace(/\/+$/, '')}/api/sdk/bootstrap`;
    const bootstrap = z.object({ manifest: z.unknown().optional(), manifest_url: z.string().optional() })
      .parse(parseJson(await readBytes(bootstrapUrl, MAX_METADATA_BYTES, apiKey)));
    let rawManifest = bootstrap.manifest;
    if (rawManifest === undefined) {
      if (!bootstrap.manifest_url) throw new Error('Bootstrap supplied no manifest');
      rawManifest = parseJson(await readBytes(deliveryUrl(bootstrap.manifest_url), MAX_METADATA_BYTES));
    }
    // Trust the authenticated HTTPS bootstrap, then check content integrity.
    // The optional detached Ed25519 signature is NOT verified by this example.
    const manifest = manifestSchema.parse(rawManifest);
    if (manifest.tenant_id !== tenantId) throw new Error('Playbook manifest tenant mismatch');
    checkWindow(manifest, now());
    const bundleUrl = deliveryUrl(manifest.active.url);
    if (manifest.active.byte_length > MAX_BUNDLE_BYTES) throw new Error('Playbook exceeds size limit');
    let playbook = snapshot?.sha256 === manifest.active.sha256 ? snapshot.playbook : undefined;
    if (!playbook) {
      const bytes = await readBytes(bundleUrl, MAX_BUNDLE_BYTES); // Never forward the API key.
      if (bytes.byteLength !== manifest.active.byte_length) throw new Error('Playbook byte length mismatch');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (sha256 !== manifest.active.sha256) throw new Error('Playbook integrity mismatch');
      const raw = parseJson(bytes);
      const envelope = payloadEnvelope.parse(raw);
      if (envelope.tenant_id !== tenantId || envelope.environment_id !== environmentId) {
        throw new Error('Playbook payload scope mismatch');
      }
      playbook = normalizeConfigArtifactOrThrow(raw, 'CDN Playbook', { tenantId, environmentId });
      if (!playbook) throw new Error('Empty Playbook');
      deepFreeze(playbook);
    }
    const loadedAt = now();
    checkWindow(manifest, loadedAt); // A slow fetch must not activate an expired manifest.
    const expiresAt = Date.parse(manifest.expires_at);
    snapshot = Object.freeze({ playbook, sha256: manifest.active.sha256,
      configVersion: manifest.config_version, expiresAt, refreshAt: Math.min(loadedAt + REFRESH_MS, expiresAt) });
    return snapshot;
  }

  return {
    async get(): Promise<PlaybookSnapshot> {
      if (snapshot && now() < snapshot.refreshAt) return snapshot;
      if (inFlight) return inFlight;
      if (now() < retryAt) throw lastError;
      inFlight = refresh().catch(error => {
        lastError = error;
        retryAt = now() + 1_000; // Bound repeated failures during an outage.
        throw error; // Never serve the previous snapshot after its refresh deadline.
      }).finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
