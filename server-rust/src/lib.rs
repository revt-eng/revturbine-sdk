//! RevTurbine Server-Side SDK for Rust.
//!
//! Performs server-to-server evaluation calls against the RevTurbine decision
//! engine and returns a [`ServerEvaluationPayload`] (from the generated
//! `revturbine-schema-types` crate) that the client-side SDK can hydrate.
//!
//! # Example
//!
//! ```rust,no_run
//! use revturbine_server_sdk::{RevTurbineServer, RevTurbineServerOptions, PlacementRequest};
//!
//! #[tokio::main]
//! async fn main() {
//!     let server = RevTurbineServer::new(RevTurbineServerOptions {
//!         tenant_id: "tenant_abc".into(),
//!         api_key: "rt_secret_xxx".into(),
//!         endpoint: "https://api.revturbine.io".into(),
//!         default_ttl_seconds: 60,
//!     });
//!
//!     let payload = server.evaluate(EvaluationRequest {
//!         user_id: "user_123".into(),
//!         placements: vec![PlacementRequest { slot_id: Some("hero_banner".into()), ..Default::default() }],
//!         ..Default::default()
//!     }).await.unwrap();
//!
//!     println!("{}", serde_json::to_string_pretty(&payload).unwrap());
//! }
//! ```

mod client;

// Re-export generated payload types from revturbine-schema-types
pub use revturbine_schema_types::{
    ServerEvaluationPayload,
    ServerEvaluationPayloadDecisionsItem,
    ServerEvaluationPayloadEntitlementsValue,
    ServerEvaluationPayloadTrialStatus,
    ServerEvaluationPayloadUser,
    ServerEvaluationPayloadUserContext,
};

pub use client::{
    EvaluationRequest,
    PlacementRequest,
    RevTurbineServer,
    RevTurbineServerOptions,
};
