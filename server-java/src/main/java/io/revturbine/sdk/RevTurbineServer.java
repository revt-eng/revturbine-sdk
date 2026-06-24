package io.revturbine.sdk;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import java.io.IOException;
import java.lang.reflect.Type;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * RevTurbine Server-Side SDK Client.
 *
 * <p>Performs server-to-server evaluation calls against the RevTurbine decision
 * engine and returns a serializable {@link Types.ServerEvaluationPayload} that
 * the client-side SDK can hydrate.
 *
 * <h3>Usage</h3>
 * <pre>{@code
 * RevTurbineServer server = new RevTurbineServer(
 *     new RevTurbineServerOptions("tenant_abc", "rt_secret_xxx", "https://api.revturbine.io")
 * );
 *
 * Types.EvaluationRequest req = new Types.EvaluationRequest();
 * req.userId = "user_123";
 * req.placements = List.of(placement);
 * req.includeTheme = true;
 *
 * Types.ServerEvaluationPayload payload = server.evaluate(req);
 * // Serialize payload and send to client-side SDK
 * }</pre>
 */
public class RevTurbineServer {
    private static final MediaType JSON_MEDIA = MediaType.get("application/json");
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    private final RevTurbineServerOptions options;
    private final OkHttpClient httpClient;

    public RevTurbineServer(RevTurbineServerOptions options) {
        this.options = options;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build();
    }

    /**
     * Evaluate placement decisions, entitlements, and context for a user.
     */
    public Types.ServerEvaluationPayload evaluate(Types.EvaluationRequest request) throws IOException {
        String requestId = UUID.randomUUID().toString();
        String anonymousId = request.anonymousId != null ? request.anonymousId : UUID.randomUUID().toString();

        List<Types.PlacementDecision> decisions = evaluatePlacements(requestId, request);
        Map<String, Types.EntitlementResult> entitlements = evaluateEntitlements(request);
        Types.TrialStatus trialStatus = request.includeTrialStatus
                ? fetchTrialStatus(requestId, request.userId) : null;
        Types.UserContext userContext = request.includeUserContext
                ? fetchUserContext(requestId, request.userId) : null;
        Map<String, Object> theme = request.includeTheme
                ? fetchTheme(requestId) : null;

        Types.ServerEvaluationPayload payload = new Types.ServerEvaluationPayload();
        payload.version = "1.0.0";
        payload.requestId = requestId;
        payload.tenantId = options.getTenantId();
        payload.evaluatedAt = Instant.now().toString();
        payload.ttlSeconds = options.getDefaultTtlSeconds();

        payload.user = new Types.PayloadUser();
        payload.user.id = request.userId;
        payload.user.anonymousId = anonymousId;
        payload.user.traits = request.traits;

        payload.decisions = decisions;
        payload.entitlements = entitlements;
        payload.trialStatus = trialStatus;
        payload.userContext = userContext;
        payload.theme = theme;

        return payload;
    }

    /**
     * Check a single entitlement for a user.
     */
    public Types.EntitlementResult checkEntitlement(String userId, String handle) throws IOException {
        String requestId = UUID.randomUUID().toString();
        Map<String, Object> body = new HashMap<>();
        body.put("request_id", requestId);
        body.put("user_id", userId);
        body.put("entitlement_handle", handle);

        try {
            String responseBody = apiPost(requestId, "/api/decision-api/v1/check-entitlement", body);
            return GSON.fromJson(responseBody, Types.EntitlementResult.class);
        } catch (IOException e) {
            Types.EntitlementResult fallback = new Types.EntitlementResult();
            fallback.status = "denied";
            fallback.allowed = false;
            fallback.reason = "network_error";
            return fallback;
        }
    }

    /**
     * Fetch trial status for a user.
     */
    public Types.TrialStatus getTrialStatus(String userId) throws IOException {
        return fetchTrialStatus(UUID.randomUUID().toString(), userId);
    }

    /**
     * Serialize a payload to JSON for transport to the client.
     */
    public String toJson(Types.ServerEvaluationPayload payload) {
        return GSON.toJson(payload);
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private List<Types.PlacementDecision> evaluatePlacements(String requestId, Types.EvaluationRequest request) throws IOException {
        List<Types.PlacementRequest> placements = request.placements;
        if (placements == null || placements.isEmpty()) return Collections.emptyList();

        if (placements.size() > 1) {
            return evaluatePlacementsBatch(requestId, request, placements);
        }

        return List.of(evaluateSinglePlacement(requestId, request.userId, placements.get(0), request.traits));
    }

    private Types.PlacementDecision evaluateSinglePlacement(
            String requestId, String userId, Types.PlacementRequest placement, Map<String, Object> traits
    ) throws IOException {
        Map<String, Object> body = new HashMap<>();
        body.put("request_id", requestId);
        body.put("user_id", userId);
        body.put("traits", traits != null ? traits : Map.of());
        body.put("slot_id", placement.slotId);
        body.put("entitlement_handle", placement.entitlementHandle);
        body.put("plan_handle", placement.planHandle);
        body.put("placement_handle", placement.placementHandle);

        try {
            String responseBody = apiPost(requestId, "/api/decision-api/v1/decide-context", body);
            Type type = new TypeToken<Map<String, Object>>() {}.getType();
            Map<String, Object> data = GSON.fromJson(responseBody, type);

            Types.PlacementDecision decision = new Types.PlacementDecision();
            decision.slotId = placement.slotId;
            decision.entitlementHandle = placement.entitlementHandle;
            decision.planHandle = placement.planHandle;
            decision.placementHandle = placement.placementHandle;

            @SuppressWarnings("unchecked")
            Map<String, Object> decisionMap = (Map<String, Object>) data.get("decision");
            decision.visible = decisionMap != null && Boolean.TRUE.equals(decisionMap.get("visible"));
            if (decision.visible && decisionMap != null) {
                decision.output = decisionMap;
            }

            @SuppressWarnings("unchecked")
            List<String> codes = (List<String>) data.get("reason_codes");
            decision.reasonCodes = codes;

            return decision;
        } catch (IOException e) {
            Types.PlacementDecision fallback = new Types.PlacementDecision();
            fallback.slotId = placement.slotId;
            fallback.visible = false;
            fallback.reasonCodes = List.of("network_error");
            return fallback;
        }
    }

    private List<Types.PlacementDecision> evaluatePlacementsBatch(
            String requestId, Types.EvaluationRequest request, List<Types.PlacementRequest> placements
    ) throws IOException {
        Map<String, Object> body = new HashMap<>();
        body.put("request_id", requestId);
        body.put("user_id", request.userId);
        body.put("traits", request.traits != null ? request.traits : Map.of());
        body.put("usage_balances", request.usageBalances != null ? request.usageBalances : Map.of());

        List<Map<String, Object>> placementList = new ArrayList<>();
        for (Types.PlacementRequest p : placements) {
            Map<String, Object> pm = new HashMap<>();
            pm.put("slot_id", p.slotId);
            pm.put("entitlement_handle", p.entitlementHandle);
            pm.put("plan_handle", p.planHandle);
            pm.put("placement_handle", p.placementHandle);
            placementList.add(pm);
        }
        body.put("placements", placementList);

        try {
            String responseBody = apiPost(requestId, "/api/decision-api/v1/bootstrap-context", body);
            Type type = new TypeToken<Map<String, Object>>() {}.getType();
            Map<String, Object> data = GSON.fromJson(responseBody, type);

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> decisions = (List<Map<String, Object>>) data.get("decisions");
            if (decisions == null) return Collections.emptyList();

            List<Types.PlacementDecision> results = new ArrayList<>();
            for (int i = 0; i < decisions.size(); i++) {
                Map<String, Object> d = decisions.get(i);
                Types.PlacementRequest original = i < placements.size() ? placements.get(i) : new Types.PlacementRequest();

                Types.PlacementDecision pd = new Types.PlacementDecision();
                pd.slotId = original.slotId;
                pd.entitlementHandle = original.entitlementHandle;
                pd.planHandle = original.planHandle;
                pd.placementHandle = original.placementHandle;

                @SuppressWarnings("unchecked")
                Map<String, Object> result = (Map<String, Object>) d.get("result");
                @SuppressWarnings("unchecked")
                Map<String, Object> decisionMap = result != null ? (Map<String, Object>) result.get("decision") : null;
                pd.visible = decisionMap != null && Boolean.TRUE.equals(decisionMap.get("visible"));
                if (pd.visible && decisionMap != null) {
                    pd.output = decisionMap;
                }

                results.add(pd);
            }
            return results;
        } catch (IOException e) {
            List<Types.PlacementDecision> fallbacks = new ArrayList<>();
            for (Types.PlacementRequest p : placements) {
                Types.PlacementDecision pd = new Types.PlacementDecision();
                pd.slotId = p.slotId;
                pd.visible = false;
                pd.reasonCodes = List.of("network_error");
                fallbacks.add(pd);
            }
            return fallbacks;
        }
    }

    private Map<String, Types.EntitlementResult> evaluateEntitlements(Types.EvaluationRequest request) {
        List<String> handles = request.entitlementHandles;
        if (handles == null || handles.isEmpty()) return null;

        Map<String, Types.EntitlementResult> results = new HashMap<>();
        for (String handle : handles) {
            try {
                results.put(handle, checkEntitlement(request.userId, handle));
            } catch (IOException e) {
                Types.EntitlementResult fallback = new Types.EntitlementResult();
                fallback.status = "denied";
                fallback.allowed = false;
                fallback.reason = "network_error";
                results.put(handle, fallback);
            }
        }
        return results;
    }

    private Types.TrialStatus fetchTrialStatus(String requestId, String userId) throws IOException {
        Map<String, Object> body = new HashMap<>();
        body.put("request_id", requestId);
        body.put("user_id", userId);

        try {
            String responseBody = apiPost(requestId, "/api/decision-api/v1/trial-status", body);
            return GSON.fromJson(responseBody, Types.TrialStatus.class);
        } catch (IOException e) {
            Types.TrialStatus fallback = new Types.TrialStatus();
            fallback.inTrial = false;
            return fallback;
        }
    }

    private Types.UserContext fetchUserContext(String requestId, String userId) throws IOException {
        Map<String, Object> body = new HashMap<>();
        body.put("request_id", requestId);
        body.put("user_id", userId);

        try {
            String responseBody = apiPost(requestId, "/api/decision-api/v1/user-context", body);
            return GSON.fromJson(responseBody, Types.UserContext.class);
        } catch (IOException e) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> fetchTheme(String requestId) throws IOException {
        try {
            String responseBody = apiGet(requestId, "/api/sdk/theme");
            Type type = new TypeToken<Map<String, Object>>() {}.getType();
            return GSON.fromJson(responseBody, type);
        } catch (IOException e) {
            return null;
        }
    }

    private String apiPost(String requestId, String path, Object body) throws IOException {
        Request request = new Request.Builder()
                .url(options.getEndpoint() + path)
                .addHeader("Content-Type", "application/json")
                .addHeader("Authorization", "Bearer " + options.getApiKey())
                .addHeader("x-tenant-id", options.getTenantId())
                .addHeader("x-request-id", requestId)
                .post(RequestBody.create(GSON.toJson(body), JSON_MEDIA))
                .build();

        try (Response response = httpClient.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("API returned " + response.code());
            }
            return response.body() != null ? response.body().string() : "{}";
        }
    }

    private String apiGet(String requestId, String path) throws IOException {
        Request request = new Request.Builder()
                .url(options.getEndpoint() + path)
                .addHeader("Authorization", "Bearer " + options.getApiKey())
                .addHeader("x-tenant-id", options.getTenantId())
                .addHeader("x-request-id", requestId)
                .get()
                .build();

        try (Response response = httpClient.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("API returned " + response.code());
            }
            return response.body() != null ? response.body().string() : "{}";
        }
    }
}
