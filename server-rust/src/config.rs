//! The Playbook dual-read boundary.
//!
//! Normalizes a **canonical** Playbook or a **known legacy** artifact into one
//! Playbook shape, so everything downstream reads a single format.
//!
//! Source: revturbine-scaffold's config-artifact boundary, mirrored by
//! `server-python/src/revturbine/config.py`.

use serde_json::{Map, Value};

/// The only format version this reader accepts, on either path.
pub const PLAYBOOK_FORMAT_VERSION: &str = "1.0.0";

/// Body arrays a Playbook must carry. Their **absence** is an error, but an
/// empty array is fine — "no segments" is a valid Playbook, "segments is not a
/// list" is a malformed one.
const REQUIRED_BODY_ARRAY_FIELDS: &[&str] = &[
    "plans",
    "entitlements",
    "entitlement_rules",
    "segments",
    "content_ui_paths",
];

/// Deprecated projections. Still accepted, but a caller should surface them —
/// see [`legacy_projection_fields`].
const LEGACY_PROJECTION_FIELDS: &[&str] = &["slot_configs", "content_overrides"];

/// Target values for legacy artifacts that predate target stamping.
#[derive(Debug, Clone)]
pub struct LegacyConfigTargetDefaults {
    /// Tenant to assume when the artifact carries none.
    pub tenant_id: String,
    /// Environment to assume when the artifact carries none.
    pub environment_id: String,
}

/// Deprecated projection fields present on `raw`.
///
/// The Python port emits a `DeprecationWarning` here. This crate has no
/// logging facility and a headless SDK should not print, so the detection is
/// exposed instead and the caller decides — the fields are still accepted
/// either way, exactly as in the other ports.
#[must_use]
pub fn legacy_projection_fields(raw: &Value) -> Vec<&'static str> {
    LEGACY_PROJECTION_FIELDS
        .iter()
        .filter(|f| raw.get(**f).is_some())
        .copied()
        .collect()
}

fn require_non_empty_string(
    value: Option<&Value>,
    source: &str,
    field: &str,
) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Invalid {source}: missing non-empty string \"{field}\""))
}

/// Normalize a canonical or known-legacy artifact into a Playbook.
///
/// `Ok(None)` for a null input. `Err` for anything malformed — this **throws
/// rather than degrades**, because a partially-understood Playbook can
/// silently over-grant.
///
/// # Why either discriminator selects the canonical path
///
/// The presence of `artifact_type` **or** `format_version` commits to the
/// canonical branch. An unsupported future `format_version` therefore
/// *rejects* instead of falling through to legacy parsing and being
/// misread as an older artifact.
pub fn parse_playbook_or_throw(
    raw: Option<&Value>,
    source: &str,
    legacy_target_defaults: Option<&LegacyConfigTargetDefaults>,
) -> Result<Option<Value>, String> {
    let Some(raw) = raw.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let Some(obj) = raw.as_object() else {
        return Err(format!("Invalid {source}: expected top-level object"));
    };

    let canonical = obj.contains_key("artifact_type") || obj.contains_key("format_version");

    let (tenant_id, environment_id, playbook_version_id) = if canonical {
        if raw.get("artifact_type").and_then(Value::as_str) != Some("playbook") {
            return Err(format!("Invalid {source}: unsupported \"artifact_type\""));
        }
        if raw.get("format_version").and_then(Value::as_str) != Some(PLAYBOOK_FORMAT_VERSION) {
            return Err(format!(
                "Invalid {source}: unsupported \"format_version\" {}",
                raw.get("format_version").unwrap_or(&Value::Null)
            ));
        }
        (
            require_non_empty_string(raw.get("tenant_id"), source, "tenant_id")?,
            require_non_empty_string(raw.get("environment_id"), source, "environment_id")?,
            raw.get("playbook_version_id").cloned(),
        )
    } else {
        if raw.get("version").and_then(Value::as_str) != Some(PLAYBOOK_FORMAT_VERSION) {
            return Err(format!(
                "Invalid {source}: unsupported legacy \"version\" {}",
                raw.get("version").unwrap_or(&Value::Null)
            ));
        }
        // Legacy artifacts may predate target stamping; the caller's defaults
        // fill in, but only when the artifact itself has nothing usable.
        let pick = |key: &str, fallback: Option<&String>| -> Option<String> {
            raw.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| fallback.cloned())
        };
        let tenant = pick("tenant_id", legacy_target_defaults.map(|d| &d.tenant_id));
        let env = pick(
            "environment_id",
            legacy_target_defaults.map(|d| &d.environment_id),
        );
        (
            require_non_empty_string(
                tenant.as_deref().map(Value::from).as_ref(),
                source,
                "tenant_id",
            )?,
            require_non_empty_string(
                env.as_deref().map(Value::from).as_ref(),
                source,
                "environment_id",
            )?,
            raw.get("change_set_id").cloned(),
        )
    };

    let playbook_version_id = playbook_version_id.unwrap_or(Value::Null);
    if !playbook_version_id.is_null() && !playbook_version_id.is_string() {
        return Err(format!(
            "Invalid {source}: \"playbook_version_id\" must be a string or null"
        ));
    }

    let playbook_handle = raw
        .get("playbook_handle")
        .cloned()
        .unwrap_or_else(|| Value::String("default".into()));
    require_non_empty_string(Some(&playbook_handle), source, "playbook_handle")?;

    if let Some(project_id) = raw.get("project_id").filter(|v| !v.is_null()) {
        require_non_empty_string(Some(project_id), source, "project_id")?;
    }
    if let Some(exported_at) = raw.get("exported_at").filter(|v| !v.is_null()) {
        if !exported_at.is_string() {
            return Err(format!(
                "Invalid {source}: \"exported_at\" must be a string"
            ));
        }
    }
    if let Some(schema_version) = raw.get("schema_version").filter(|v| !v.is_null()) {
        require_non_empty_string(Some(schema_version), source, "schema_version")?;
    }
    for field in [
        "bundle_schema_version",
        "bundle_min_readable_schema_version",
    ] {
        if let Some(v) = raw.get(field).filter(|v| !v.is_null()) {
            // `as_u64` declines booleans and negatives alike.
            if v.as_u64().is_none() {
                return Err(format!(
                    "Invalid {source}: \"{field}\" must be a non-negative integer"
                ));
            }
        }
    }

    // The legacy discriminators are dropped, not carried alongside the
    // canonical ones — a normalized artifact must not still look legacy.
    let mut normalized: Map<String, Value> = obj
        .iter()
        .filter(|(k, _)| k.as_str() != "version" && k.as_str() != "change_set_id")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    normalized.insert("artifact_type".into(), Value::String("playbook".into()));
    normalized.insert(
        "format_version".into(),
        Value::String(PLAYBOOK_FORMAT_VERSION.into()),
    );
    normalized.insert("playbook_handle".into(), playbook_handle);
    normalized.insert("playbook_version_id".into(), playbook_version_id);
    normalized.insert("tenant_id".into(), Value::String(tenant_id));
    normalized.insert("environment_id".into(), Value::String(environment_id));

    for key in REQUIRED_BODY_ARRAY_FIELDS {
        if !normalized.get(*key).is_some_and(Value::is_array) {
            return Err(format!("Invalid {source}: missing array \"{key}\""));
        }
    }

    Ok(Some(Value::Object(normalized)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body() -> Map<String, Value> {
        json!({
            "plans": [], "entitlements": [], "entitlement_rules": [],
            "segments": [], "content_ui_paths": [],
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn canonical() -> Value {
        let mut m = body();
        m.insert("artifact_type".into(), json!("playbook"));
        m.insert("format_version".into(), json!("1.0.0"));
        m.insert("tenant_id".into(), json!("t1"));
        m.insert("environment_id".into(), json!("env1"));
        Value::Object(m)
    }

    fn legacy() -> Value {
        let mut m = body();
        m.insert("version".into(), json!("1.0.0"));
        m.insert("tenant_id".into(), json!("t1"));
        m.insert("environment_id".into(), json!("env1"));
        m.insert("change_set_id".into(), json!("cs_9"));
        Value::Object(m)
    }

    #[test]
    fn null_input_is_not_an_error() {
        assert_eq!(parse_playbook_or_throw(None, "src", None), Ok(None));
        assert_eq!(
            parse_playbook_or_throw(Some(&Value::Null), "src", None),
            Ok(None)
        );
    }

    #[test]
    fn both_shapes_normalize_to_the_same_canonical_artifact() {
        let a = parse_playbook_or_throw(Some(&canonical()), "src", None)
            .unwrap()
            .unwrap();
        let b = parse_playbook_or_throw(Some(&legacy()), "src", None)
            .unwrap()
            .unwrap();

        assert_eq!(a["artifact_type"], json!("playbook"));
        assert_eq!(b["artifact_type"], json!("playbook"));
        assert_eq!(b["format_version"], json!("1.0.0"));
        // The legacy `change_set_id` becomes the canonical version id...
        assert_eq!(b["playbook_version_id"], json!("cs_9"));
        // ...and the legacy discriminators are GONE, so a normalized artifact
        // cannot still be read as legacy.
        assert!(b.get("version").is_none());
        assert!(b.get("change_set_id").is_none());
    }

    #[test]
    fn an_unsupported_format_version_rejects_rather_than_falling_back() {
        // Either discriminator commits to the canonical path, so a future
        // version cannot be silently misread as a legacy artifact.
        let mut future = canonical();
        future["format_version"] = json!("2.0.0");
        assert!(parse_playbook_or_throw(Some(&future), "src", None).is_err());

        let mut no_type = canonical();
        no_type.as_object_mut().unwrap().remove("artifact_type");
        no_type["format_version"] = json!("2.0.0");
        assert!(
            parse_playbook_or_throw(Some(&no_type), "src", None).is_err(),
            "format_version alone still selects the canonical path",
        );
    }

    #[test]
    fn legacy_defaults_fill_in_only_what_the_artifact_lacks() {
        let mut untargeted = legacy();
        untargeted.as_object_mut().unwrap().remove("tenant_id");
        let defaults = LegacyConfigTargetDefaults {
            tenant_id: "fallback_tenant".into(),
            environment_id: "fallback_env".into(),
        };

        let out = parse_playbook_or_throw(Some(&untargeted), "src", Some(&defaults))
            .unwrap()
            .unwrap();
        assert_eq!(out["tenant_id"], json!("fallback_tenant"));
        assert_eq!(
            out["environment_id"],
            json!("env1"),
            "the artifact's own value wins over the default",
        );
    }

    #[test]
    fn a_missing_body_array_is_an_error_but_an_empty_one_is_fine() {
        // "no segments" is a valid Playbook; "segments is not a list" is not.
        let mut missing = canonical();
        missing.as_object_mut().unwrap().remove("segments");
        assert!(parse_playbook_or_throw(Some(&missing), "src", None).is_err());

        let mut wrong_type = canonical();
        wrong_type["segments"] = json!({});
        assert!(parse_playbook_or_throw(Some(&wrong_type), "src", None).is_err());

        assert!(parse_playbook_or_throw(Some(&canonical()), "src", None).is_ok());
    }

    #[test]
    fn required_identity_fields_must_be_non_empty() {
        for field in ["tenant_id", "environment_id"] {
            let mut blank = canonical();
            blank[field] = json!("");
            assert!(
                parse_playbook_or_throw(Some(&blank), "src", None).is_err(),
                "empty {field} must reject",
            );
        }
    }

    #[test]
    fn bundle_schema_versions_must_be_non_negative_integers() {
        for bad in [json!(-1), json!(1.5), json!(true), json!("3")] {
            let mut m = canonical();
            m["bundle_schema_version"] = bad.clone();
            assert!(
                parse_playbook_or_throw(Some(&m), "src", None).is_err(),
                "{bad} should reject",
            );
        }
        let mut good = canonical();
        good["bundle_schema_version"] = json!(3);
        assert!(parse_playbook_or_throw(Some(&good), "src", None).is_ok());
    }

    #[test]
    fn playbook_handle_defaults_and_deprecated_projections_are_detectable() {
        let out = parse_playbook_or_throw(Some(&canonical()), "src", None)
            .unwrap()
            .unwrap();
        assert_eq!(out["playbook_handle"], json!("default"));

        let mut deprecated = canonical();
        deprecated["slot_configs"] = json!([]);
        assert_eq!(legacy_projection_fields(&deprecated), vec!["slot_configs"]);
        assert!(
            parse_playbook_or_throw(Some(&deprecated), "src", None).is_ok(),
            "deprecated projections are surfaced, not rejected",
        );
    }

    #[test]
    fn a_non_object_is_rejected() {
        assert!(parse_playbook_or_throw(Some(&json!("nope")), "src", None).is_err());
        assert!(parse_playbook_or_throw(Some(&json!([])), "src", None).is_err());
    }
}
