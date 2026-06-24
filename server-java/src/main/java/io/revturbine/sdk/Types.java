package io.revturbine.sdk;

import com.google.gson.annotations.SerializedName;
import java.util.List;
import java.util.Map;

/**
 * Types for the RevTurbine Server-Side SDK.
 *
 * These model the {@code ServerEvaluationPayload} contract defined in
 * {@code revturbine-schema/schemas/v1.0.0/decision/server_evaluation_payload.json}.
 */
public final class Types {

    private Types() {}

    /** A single placement to evaluate on the server. */
    public static class PlacementRequest {
        @SerializedName("slot_id")
        public String slotId;

        @SerializedName("entitlement_handle")
        public String entitlementHandle;

        @SerializedName("plan_handle")
        public String planHandle;

        @SerializedName("placement_handle")
        public String placementHandle;
    }

    /** Full evaluation request submitted to the server SDK. */
    public static class EvaluationRequest {
        @SerializedName("user_id")
        public String userId;

        @SerializedName("anonymous_id")
        public String anonymousId;

        public Map<String, Object> traits;

        public PageContext page;

        public List<PlacementRequest> placements;

        @SerializedName("entitlement_handles")
        public List<String> entitlementHandles;

        @SerializedName("usage_balances")
        public Map<String, Double> usageBalances;

        @SerializedName("include_theme")
        public boolean includeTheme;

        @SerializedName("include_trial_status")
        public boolean includeTrialStatus;

        @SerializedName("include_user_context")
        public boolean includeUserContext;
    }

    /** Page context for server-side rendering. */
    public static class PageContext {
        public String url;
        public String title;
        public List<String> tags;
    }

    /** User identity within the evaluation payload. */
    public static class PayloadUser {
        public String id;

        @SerializedName("anonymous_id")
        public String anonymousId;

        public Map<String, Object> traits;
    }

    /** A single placement decision in the payload. */
    public static class PlacementDecision {
        @SerializedName("slot_id")
        public String slotId;

        @SerializedName("entitlement_handle")
        public String entitlementHandle;

        @SerializedName("plan_handle")
        public String planHandle;

        @SerializedName("placement_handle")
        public String placementHandle;

        public boolean visible;

        /** Full placement output from the decision engine (opaque JSON object). */
        public Map<String, Object> output;

        @SerializedName("reason_codes")
        public List<String> reasonCodes;
    }

    /** Entitlement check result. */
    public static class EntitlementResult {
        public String status; // "allowed" | "limited" | "denied"
        public boolean allowed;
        public String reason;

        @SerializedName("current_tier")
        public String currentTier;
    }

    /** Trial status for the identified user. */
    public static class TrialStatus {
        @SerializedName("in_trial")
        public boolean inTrial;

        @SerializedName("trial_type")
        public String trialType;

        @SerializedName("plan_handle")
        public String planHandle;

        @SerializedName("day_number")
        public Integer dayNumber;

        @SerializedName("days_remaining")
        public Integer daysRemaining;
    }

    /** Resolved user context for targeting/personalization. */
    public static class UserContext {
        public List<String> segments;
        public Map<String, Object> traits;

        @SerializedName("usage_balances")
        public Map<String, Double> usageBalances;
    }

    /**
     * The serializable payload produced by server-side evaluation.
     * Pass this to the client-side SDK via {@code sdk.hydrate(payload)}.
     */
    public static class ServerEvaluationPayload {
        public String version;

        @SerializedName("request_id")
        public String requestId;

        @SerializedName("tenant_id")
        public String tenantId;

        @SerializedName("evaluated_at")
        public String evaluatedAt;

        @SerializedName("ttl_seconds")
        public int ttlSeconds;

        public PayloadUser user;

        public List<PlacementDecision> decisions;

        public Map<String, EntitlementResult> entitlements;

        public Map<String, Object> theme;

        @SerializedName("trial_status")
        public TrialStatus trialStatus;

        @SerializedName("user_context")
        public UserContext userContext;
    }
}
