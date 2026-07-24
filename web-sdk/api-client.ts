/**
 * RevTurbine API Client — typed client for the RevTurbine API.
 *
 * Generated from `@revt-eng/schema` external OpenAPI spec via `openapi-typescript`.
 * Uses `openapi-fetch` for type-safe requests with auth injection.
 *
 * @example
 * ```ts
 * const client = createRevTurbineApiClient({
 *   baseUrl: 'https://edge.example.com',
 *   token: 'rt_live_xxx',
 *   tenantId: 'tenant_abc',
 * });
 *
 * const { data } = await client.GET('/api/plans');
 * ```
 */
import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './generated/openapi';

export interface RevTurbineApiClientConfig {
  /** Base URL of the RevTurbine API. */
  baseUrl: string;
  /** API token for authentication. */
  token?: string;
  /** Tenant ID to include in requests. */
  tenantId?: string;
  /** Additional headers to include in every request. */
  headers?: Record<string, string>;
}

export type RevTurbineApiClient = Client<paths>;

/**
 * Create a configured RevTurbine API client instance.
 *
 * @param config - Client configuration.
 * @returns Typed API client with GET, POST, PUT, PATCH, DELETE methods.
 */
export function createRevTurbineApiClient(config: RevTurbineApiClientConfig): RevTurbineApiClient {
  const headers: Record<string, string> = { ...config.headers };
  if (config.tenantId) {
    headers['x-rt-tenant-id'] = config.tenantId;
  }
  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }

  return createClient<paths>({
    baseUrl: config.baseUrl,
    headers,
  });
}

/** Error thrown when an API request fails. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Re-export generated path types for consumers
export type { paths } from './generated/openapi';
