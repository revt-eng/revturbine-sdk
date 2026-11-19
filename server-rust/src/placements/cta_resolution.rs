//! Port of core/cta-resolution.ts: semantic CTAs and legacy projection.
use super::local_resolver::normalize_cta_path;
use serde_json::{json, Value};

fn text<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn default_role(path: &str, component: &str) -> Option<&'static str> {
    Some(match path {
        "dismiss" => {
            if matches!(component, "banner" | "toast") {
                "dismiss"
            } else {
                "not_now"
            }
        }
        "open_checkout" => "purchase",
        "view_plans" | "open_rt_placement" => "learn_more",
        "book_demo" | "contact_sales" => "contact",
        "complete_onboarding"
        | "invite_teammate"
        | "refer_friend"
        | "verify_work_email"
        | "extend_trial" => "engage",
        "update_payment_method" | "manage_subscription" => "continue",
        "enable_auto_renewal" | "switch_billing_period" => "manage",
        "snooze" => "snooze",
        _ => return None,
    })
}

pub(super) fn authored_surface_ctas(surface: &Value) -> Vec<Value> {
    if let Some(rows) = surface
        .get("ctas")
        .and_then(Value::as_array)
        .filter(|r| !r.is_empty())
    {
        return rows
            .iter()
            .filter(|c| c.get("label").is_some_and(Value::is_string))
            .cloned()
            .collect();
    }
    surface
        .get("fields")
        .and_then(|f| text(f, "cta_label"))
        .map(|label| vec![json!({"label":label})])
        .unwrap_or_default()
}

pub(super) fn resolve_ctas(authored: &[Value], component: &str, paths: &[Value]) -> Vec<Value> {
    let rows: Vec<_> = authored.iter().take(5).collect();
    let mut primary_taken = rows.iter().any(|c| text(c, "emphasis") == Some("primary"));
    rows.into_iter().map(|cta| {
        let path = text(cta, "path").unwrap_or("dismiss");
        let inherited = if path == "custom" {
            let handle = cta.get("config").and_then(|c| text(c, "handle"));
            paths.iter().find(|p| handle.is_some() && text(p,"name") == handle).and_then(|p| {
                text(p,"role").or_else(|| {
                    let action = text(p,"action_type")?;
                    let mapped = match action { "open_checkout_modal" => "open_checkout", "navigate_to_plans" => "view_plans", "open_placement" => "open_rt_placement", other => other };
                    default_role(mapped, component)
                })
            })
        } else { default_role(path, component) };
        let authored_role = text(cta,"role");
        let role = authored_role.or(inherited);
        let emphasis = match text(cta,"emphasis") {
            Some(e @ ("primary" | "secondary" | "link")) => e,
            _ if matches!(role, Some("dismiss" | "not_now" | "snooze")) => "link",
            _ if !primary_taken => { primary_taken = true; "primary" },
            _ => "secondary",
        };
        let mut out = json!({"label":cta["label"],"path":normalize_cta_path(Some(cta)),"role_overridden":authored_role.is_some() && authored_role != inherited,"emphasis":emphasis});
        if let Some(role) = role { out["role"] = json!(role); }
        out
    }).collect()
}

pub(super) fn project_compatibility(ctas: &[Value]) -> Value {
    let Some(primary) = ctas
        .iter()
        .find(|c| text(c, "emphasis") == Some("primary"))
        .or_else(|| ctas.first())
    else {
        return json!({});
    };
    let mut out = json!({"cta_path": primary["path"], "cta_label": primary["label"]});
    if let Some(second) = ctas.get(1) {
        out["secondary_cta_label"] = second["label"].clone();
    }
    out
}

pub(super) fn overlay_ctas(base: &[Value], content: &Value) -> Vec<Value> {
    let mut result = base.to_vec();
    let legacy = vec![
        json!({"label":content.get("cta_label")}),
        json!({"label":content.get("secondary_cta_label")}),
    ];
    let rows = content
        .get("ctas")
        .and_then(Value::as_array)
        .filter(|r| !r.is_empty())
        .unwrap_or(&legacy);
    for (index, row) in rows.iter().enumerate() {
        if !row.get("label").is_some_and(Value::is_string) {
            continue;
        }
        let mut patch = json!({"label":row["label"]});
        for key in ["role", "emphasis"] {
            if let Some(v) = text(row, key) {
                patch[key] = json!(v);
            }
        }
        if index < result.len() {
            result[index]
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
        } else if index == result.len() {
            result.push(patch);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_and_primary_projection_preserve_authored_order() {
        let rows = vec![
            json!({"label":"Later","path":"dismiss"}),
            json!({"label":"Buy","path":"open_checkout","role":"upgrade"}),
            json!({"label":"Help","path":"custom","config":{"handle":"help"}}),
            json!({"label":"Continue","path":"manage_subscription","emphasis":"primary"}),
            json!({"label":"More","path":"custom","config":{"handle":"plans"}}),
            json!({"label":"Ignored","path":"view_plans"}),
        ];
        let paths = vec![
            json!({"name":"help","role":"account_help"}),
            json!({"name":"plans","action_type":"navigate_to_plans"}),
        ];
        let ctas = resolve_ctas(&rows, "modal", &paths);
        assert_eq!(
            ctas.iter()
                .map(|c| c["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "not_now",
                "upgrade",
                "account_help",
                "continue",
                "learn_more"
            ]
        );
        assert_eq!(
            ctas.iter()
                .map(|c| c["emphasis"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["link", "secondary", "secondary", "primary", "secondary"]
        );
        assert_eq!(
            project_compatibility(&ctas),
            json!({"cta_path":{"type":"manage_subscription"},"cta_label":"Continue","secondary_cta_label":"Buy"})
        );
        assert_eq!(
            ctas.iter()
                .map(|c| c["role_overridden"].as_bool().unwrap())
                .collect::<Vec<_>>(),
            vec![false, true, false, false, false]
        );
    }

    #[test]
    fn block_roles_overlay_without_replacing_paths() {
        let base = vec![json!({"label":"Buy","path":"open_checkout","config":{"purchase":"pro"}})];
        let rows = overlay_ctas(
            &base,
            &json!({"ctas":[{"label":"Proceed","role":"continue"},{"label":"Later"}],"cta_label":"Ignored"}),
        );
        let ctas = resolve_ctas(&rows, "banner", &[]);
        assert_eq!(
            ctas[0]["path"],
            json!({"type":"open_checkout","plan_handle":"pro"})
        );
        assert_eq!(ctas[0]["role"], "continue");
        assert_eq!(ctas[0]["role_overridden"], true);
        assert_eq!(ctas[1]["path"], json!({"type":"dismiss"}));
        assert_eq!(ctas[1]["role"], "dismiss");
        assert_eq!(base[0]["label"], "Buy");
    }
}
