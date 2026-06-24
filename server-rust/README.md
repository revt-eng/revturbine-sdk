# RevTurbine Server SDK — Rust

Server-side evaluation SDK for Rust. Calls the RevTurbine decision engine
and returns a `ServerEvaluationPayload` (from the generated
`revturbine-schema-types` crate) that the client-side SDK can hydrate.

## Types

All payload types (`ServerEvaluationPayload`, `ServerEvaluationPayloadDecisionsItem`,
etc.) are re-exported from the generated `revturbine-schema-types` crate so field
names and struct shapes always match the JSON-Schema source of truth.

## Usage

```rust
use revturbine_server_sdk::{RevTurbineServer, RevTurbineServerOptions, EvaluationRequest, PlacementRequest};

#[tokio::main]
async fn main() {
    let server = RevTurbineServer::new(RevTurbineServerOptions {
        tenant_id: "tenant_abc".into(),
        api_key: "rt_secret_xxx".into(),
        endpoint: "https://api.revturbine.io".into(),
        default_ttl_seconds: 60,
    });

    let payload = server.evaluate(EvaluationRequest {
        user_id: "user_123".into(),
        placements: vec![PlacementRequest {
            slot_id: Some("hero_banner".into()),
            ..Default::default()
        }],
        include_theme: true,
        ..Default::default()
    }).await.unwrap();

    println!("{}", serde_json::to_string_pretty(&payload).unwrap());
}
```

## Dependencies

- `revturbine-schema-types` — generated domain types (via path dependency)
- `reqwest` — async HTTP client
- `serde` / `serde_json` — serialization
- `tokio` — async runtime
- `uuid` — request ID generation
- `chrono` — ISO-8601 timestamps
