package io.revturbine.sdk;

/**
 * Configuration for the RevTurbine server-side SDK.
 */
public class RevTurbineServerOptions {
    private final String tenantId;
    private final String apiKey;
    private final String endpoint;
    private int defaultTtlSeconds = 60;

    public RevTurbineServerOptions(String tenantId, String apiKey, String endpoint) {
        if (tenantId == null || tenantId.isEmpty()) throw new IllegalArgumentException("tenantId is required");
        if (apiKey == null || apiKey.isEmpty()) throw new IllegalArgumentException("apiKey is required");
        if (endpoint == null || endpoint.isEmpty()) throw new IllegalArgumentException("endpoint is required");

        this.tenantId = tenantId;
        this.apiKey = apiKey;
        this.endpoint = endpoint.replaceAll("/$", "");
    }

    public String getTenantId() { return tenantId; }
    public String getApiKey() { return apiKey; }
    public String getEndpoint() { return endpoint; }
    public int getDefaultTtlSeconds() { return defaultTtlSeconds; }

    public RevTurbineServerOptions defaultTtlSeconds(int ttl) {
        this.defaultTtlSeconds = ttl;
        return this;
    }
}
