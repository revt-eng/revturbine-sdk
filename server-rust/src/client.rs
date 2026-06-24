//! Server-side evaluation client implementation.

use std::collections::HashMap;

use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// Import generated types from revturbine-schema-types
use revturbine_schema_types::{
    ServerEvaluationPayload,
    ServerEvaluationPayloadDecisionsItem,
    ServerEvaluationPayloadEntitlementsValue,
    ServerEvaluationPayloadTrialStatus,
    ServerEvaluationPayloadUser,
    ServerEvaluationPayloadUserContext,
};

// ---------------------------------------------------------------------------
// SDK-only request types (not in schema)
// ---------------------------------------------------------------------------

/// Server SDK configuration options.
pub struct RevTurbineServerOptions {
    pub tenant_id: String,
    pub api_key: String,
    pub endpoint: String,
    pub default_ttl_seconds: i64,
}

/// A single placement to evaluate.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PlacementRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entitlement_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement_handle: Option<String>,
}

/// Full evaluation request.
#[derive(Debug, Clone, Default)]
pub struct EvaluationRequest {
    pub user_id: String,
    pub anonymous_id: Option<String>,
    pub traits: Option<HashMap<String, serde_json::Value>>,
    pub page: Option<HashMap<String, serde_json::Value>>,
    pub placements: Vec<PlacementRequest>,
    pub entitlement_handles: Vec<String>,
    pub usage_balances: Option<HashMap<String, f64>>,
    pub include_theme: bool,
    pub include_trial_status: bool,
    pub include_user_context: bool,
}

// ---------------------------------------------------------------------------
// Internal API response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DecideContextResponse {
    #[allow(dead_code)]
    request_id: Option<String>,
    reason_codes: Option<Vec<String>>,
    decision: Option<DecideContextDecision>,
}

#[derive(Debug, Deserialize)]
struct DecideContextDecision {
    visible: Option<bool>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct BootstrapContextResponse {
    decisions: Vec<BootstrapDecisionItem>,
}

#[derive(Debug, Deserialize)]
struct BootstrapDecisionItem {
    #[allow(dead_code)]
    placement_id: String,
    result: DecideContextResponse,
}

#[derive(Debug, Deserialize)]
struct EntitlementResponse {
    status: Option<String>,
    allowed: Option<bool>,
    reason: Option<String>,
    current_tier: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TrialStatusResponse {
    in_trial: Option<bool>,
    trial_type: Option<String>,
    plan_handle: Option<String>,
    day_number: Option<i64>,
    days_remaining: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct UserContextResponse {
    segments: Option<Vec<String>>,
    traits: Option<HashMap<String, serde_json::Value>>,
    usage_balances: Option<HashMap<String, f64>>,
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

/// Server-side RevTurbine evaluation client.
pub struct RevTurbineServer {
    tenant_id: String,
    api_key: String,
    endpoint: String,
    default_ttl_seconds: i64,
    http: Client,
}

impl RevTurbineServer {
    /// Create a new server SDK instance.
    pub fn new(options: RevTurbineServerOptions) -> Self {
        Self {
            tenant_id: options.tenant_id,
            api_key: options.api_key,
            endpoint: options.endpoint.trim_end_matches('/').to_string(),
            default_ttl_seconds: options.default_ttl_seconds,
            http: Client::new(),
        }
    }

    /// Evaluate placement decisions, entitlements, and context for a user.
    ///
    /// Returns a [`ServerEvaluationPayload`] (generated type) that can be
    /// serialized and sent to the client-side SDK for hydration.
    pub async fn evaluate(
        &self,
        request: EvaluationRequest,
    ) -> Result<ServerEvaluationPayload, Box<dyn std::error::Error>> {
        let request_id = Uuid::new_v4().to_string();
        let anonymous_id = request
            .anonymous_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let decisions = self.evaluate_placements(&request_id, &request).await;

        let entitlements = if request.entitlement_handles.is_empty() {
            None
        } else {
            Some(self.evaluate_entitlements(&request).await)
        };

        let trial_status = if request.include_trial_status {
            Some(self.fetch_trial_status(&request_id, &request.user_id).await)
        } else {
            None
        };

        let user_context = if request.include_user_context {
            self.fetch_user_context(&request_id, &request.user_id).await
        } else {
            None
        };

        let theme = if request.include_theme {
            self.fetch_theme(&request_id).await
        } else {
            None
        };

        Ok(ServerEvaluationPayload {
            version: "1.0.0".into(),
            request_id,
            tenant_id: self.tenant_id.clone(),
            evaluated_at: Utc::now().to_rfc3339(),
            ttl_seconds: self.default_ttl_seconds,
            user: ServerEvaluationPayloadUser {
                id: request.user_id,
                anonymous_id: Some(anonymous_id),
                traits: request.traits,
            },
            decisions,
            entitlements,
            theme,
            trial_status,
            user_context,
        })
    }

    /// Evaluate a single placement.
    pub async fn get_placement(
        &self,
        user_id: &str,
        placement: &PlacementRequest,
        traits: Option<&HashMap<String, serde_json::Value>>,
    ) -> ServerEvaluationPayloadDecisionsItem {
        let request_id = Uuid::new_v4().to_string();
        let body = serde_json::json!({
            "request_id": request_id,
            "user_id": user_id,
            "traits": traits.unwrap_or(&HashMap::new()),
            "slot_id": placement.slot_id,
            "entitlement_handle": placement.entitlement_handle,
            "plan_handle": placement.plan_handle,
            "placement_handle": placement.placement_handle,
        });

        match self.api_post::<DecideContextResponse>(&request_id, "/api/decision-api/v1/decide-context", &body).await {
            Ok(data) => {
                let visible = data.decision.as_ref().and_then(|d| d.visible).unwrap_or(false);
                let output = if visible {
                    data.decision.map(|d| {
                        let mut map = d.extra;
                        if let Some(v) = d.visible {
                            map.insert("visible".into(), serde_json::Value::Bool(v));
                        }
                        map
                    })
                } else {
                    None
                };
                ServerEvaluationPayloadDecisionsItem {
                    slot_id: placement.slot_id.clone(),
                    entitlement_handle: placement.entitlement_handle.clone(),
                    plan_handle: placement.plan_handle.clone(),
                    placement_handle: placement.placement_handle.clone(),
                    visible,
                    output,
                    reason_codes: data.reason_codes,
                }
            }
            Err(_) => ServerEvaluationPayloadDecisionsItem {
                slot_id: placement.slot_id.clone(),
                entitlement_handle: placement.entitlement_handle.clone(),
                plan_handle: placement.plan_handle.clone(),
                placement_handle: placement.placement_handle.clone(),
                visible: false,
                output: None,
                reason_codes: Some(vec!["network_error".into()]),
            },
        }
    }

    /// Check a single entitlement for a user.
    pub async fn check_entitlement(
        &self,
        user_id: &str,
        handle: &str,
    ) -> ServerEvaluationPayloadEntitlementsValue {
        let request_id = Uuid::new_v4().to_string();
        let body = serde_json::json!({
            "request_id": request_id,
            "user_id": user_id,
            "entitlement_handle": handle,
        });

        match self.api_post::<EntitlementResponse>(&request_id, "/api/decision-api/v1/check-entitlement", &body).await {
            Ok(data) => ServerEvaluationPayloadEntitlementsValue {
                status: data.status.unwrap_or_else(|| "denied".into()),
                allowed: data.allowed.unwrap_or(false),
                reason: data.reason,
                current_tier: data.current_tier,
            },
            Err(_) => ServerEvaluationPayloadEntitlementsValue {
                status: "denied".into(),
                allowed: false,
                reason: Some("network_error".into()),
                current_tier: None,
            },
        }
    }

    /// Fetch trial status for a user.
    pub async fn get_trial_status(&self, user_id: &str) -> ServerEvaluationPayloadTrialStatus {
        let request_id = Uuid::new_v4().to_string();
        self.fetch_trial_status(&request_id, user_id).await
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    async fn evaluate_placements(
        &self,
        request_id: &str,
        request: &EvaluationRequest,
    ) -> Vec<ServerEvaluationPayloadDecisionsItem> {
        if request.placements.is_empty() {
            return vec![];
        }

        if request.placements.len() > 1 {
            return self.evaluate_placements_batch(request_id, request).await;
        }

        vec![
            self.get_placement(&request.user_id, &request.placements[0], request.traits.as_ref())
                .await,
        ]
    }

    async fn evaluate_placements_batch(
        &self,
        request_id: &str,
        request: &EvaluationRequest,
    ) -> Vec<ServerEvaluationPayloadDecisionsItem> {
        let placements_json: Vec<_> = request
            .placements
            .iter()
            .map(|p| {
                serde_json::json!({
                    "slot_id": p.slot_id,
                    "entitlement_handle": p.entitlement_handle,
                    "plan_handle": p.plan_handle,
                    "placement_handle": p.placement_handle,
                })
            })
            .collect();

        let body = serde_json::json!({
            "request_id": request_id,
            "user_id": request.user_id,
            "traits": request.traits.as_ref().unwrap_or(&HashMap::new()),
            "usage_balances": request.usage_balances.as_ref().unwrap_or(&HashMap::new()),
            "page": request.page.as_ref().unwrap_or(&HashMap::new()),
            "placements": placements_json,
        });

        match self.api_post::<BootstrapContextResponse>(request_id, "/api/decision-api/v1/bootstrap-context", &body).await {
            Ok(data) => {
                data.decisions
                    .into_iter()
                    .enumerate()
                    .map(|(i, d)| {
                        let original = request.placements.get(i);
                        let visible = d.result.decision.as_ref().and_then(|dec| dec.visible).unwrap_or(false);
                        let output = if visible {
                            d.result.decision.map(|dec| {
                                let mut map = dec.extra;
                                if let Some(v) = dec.visible {
                                    map.insert("visible".into(), serde_json::Value::Bool(v));
                                }
                                map
                            })
                        } else {
                            None
                        };
                        ServerEvaluationPayloadDecisionsItem {
                            slot_id: original.and_then(|p| p.slot_id.clone()),
                            entitlement_handle: original.and_then(|p| p.entitlement_handle.clone()),
                            plan_handle: original.and_then(|p| p.plan_handle.clone()),
                            placement_handle: original.and_then(|p| p.placement_handle.clone()),
                            visible,
                            output,
                            reason_codes: d.result.reason_codes,
                        }
                    })
                    .collect()
            }
            Err(_) => {
                request
                    .placements
                    .iter()
                    .map(|p| ServerEvaluationPayloadDecisionsItem {
                        slot_id: p.slot_id.clone(),
                        entitlement_handle: p.entitlement_handle.clone(),
                        plan_handle: p.plan_handle.clone(),
                        placement_handle: p.placement_handle.clone(),
                        visible: false,
                        output: None,
                        reason_codes: Some(vec!["network_error".into()]),
                    })
                    .collect()
            }
        }
    }

    async fn evaluate_entitlements(
        &self,
        request: &EvaluationRequest,
    ) -> HashMap<String, ServerEvaluationPayloadEntitlementsValue> {
        let mut results = HashMap::new();
        for handle in &request.entitlement_handles {
            let result = self.check_entitlement(&request.user_id, handle).await;
            results.insert(handle.clone(), result);
        }
        results
    }

    async fn fetch_trial_status(
        &self,
        request_id: &str,
        user_id: &str,
    ) -> ServerEvaluationPayloadTrialStatus {
        let body = serde_json::json!({
            "request_id": request_id,
            "user_id": user_id,
        });

        match self.api_post::<TrialStatusResponse>(request_id, "/api/decision-api/v1/trial-status", &body).await {
            Ok(data) => ServerEvaluationPayloadTrialStatus {
                in_trial: data.in_trial.unwrap_or(false),
                trial_type: data.trial_type,
                plan_handle: data.plan_handle,
                day_number: data.day_number,
                days_remaining: data.days_remaining,
            },
            Err(_) => ServerEvaluationPayloadTrialStatus {
                in_trial: false,
                trial_type: None,
                plan_handle: None,
                day_number: None,
                days_remaining: None,
            },
        }
    }

    async fn fetch_user_context(
        &self,
        request_id: &str,
        user_id: &str,
    ) -> Option<ServerEvaluationPayloadUserContext> {
        let body = serde_json::json!({
            "request_id": request_id,
            "user_id": user_id,
        });

        match self.api_post::<UserContextResponse>(request_id, "/api/decision-api/v1/user-context", &body).await {
            Ok(data) => Some(ServerEvaluationPayloadUserContext {
                segments: data.segments,
                traits: data.traits,
                usage_balances: data.usage_balances,
            }),
            Err(_) => None,
        }
    }

    async fn fetch_theme(
        &self,
        request_id: &str,
    ) -> Option<HashMap<String, serde_json::Value>> {
        match self.api_get::<HashMap<String, serde_json::Value>>(request_id, "/api/sdk/theme").await {
            Ok(data) => Some(data),
            Err(_) => None,
        }
    }

    // -----------------------------------------------------------------------
    // HTTP helpers
    // -----------------------------------------------------------------------

    async fn api_post<T: serde::de::DeserializeOwned>(
        &self,
        request_id: &str,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T, Box<dyn std::error::Error>> {
        let url = format!("{}{}", self.endpoint, path);
        let resp = self
            .http
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", self.api_key))
            .header("x-tenant-id", &self.tenant_id)
            .header("x-request-id", request_id)
            .json(body)
            .send()
            .await?;
        let data = resp.json::<T>().await?;
        Ok(data)
    }

    async fn api_get<T: serde::de::DeserializeOwned>(
        &self,
        request_id: &str,
        path: &str,
    ) -> Result<T, Box<dyn std::error::Error>> {
        let url = format!("{}{}", self.endpoint, path);
        let resp = self
            .http
            .get(&url)
            .header("authorization", format!("Bearer {}", self.api_key))
            .header("x-tenant-id", &self.tenant_id)
            .header("x-request-id", request_id)
            .send()
            .await?;
        let data = resp.json::<T>().await?;
        Ok(data)
    }
}
