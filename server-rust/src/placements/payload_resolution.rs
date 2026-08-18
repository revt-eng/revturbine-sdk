//! Payload resolution: segment matching, block overrides, and token
//! personalization.
//!
//! Given a surface, a user context, and the authored payloads/blocks/tokens,
//! decides **which** content block a user sees and renders its
//! `{{token}}` placeholders.
//!
//! Source: revturbine-scaffold/src/placements/controllers/payload-resolution.ts

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

/// Legacy token spellings, tried when the primary name is absent.
///
/// Source: payload-resolution.ts (TOKEN_ALIASES)
const TOKEN_ALIASES: &[(&str, &str)] = &[
    ("current_usage", "usage_current"),
    ("current_limit", "usage_limit"),
    ("remaining_usage", "usage_remaining"),
];

/// The resolved outcome for one payload.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPayload {
    /// The payload that matched.
    pub payload: Value,
    /// The message block it selected.
    pub message_block: Value,
    /// The block's content with tokens substituted.
    pub resolved_content: Map<String, Value>,
    /// The segment that decided the content, if any.
    pub matched_segment_id: Option<String>,
    /// UI path carried by the payload or its matched segment entry.
    pub ui_path_id: Option<String>,
    /// Promotion carried by the payload or its matched segment entry.
    pub promotion_id: Option<String>,
}

/// Match JavaScript's `String(value)` for the kinds a personalization context
/// can hold.
///
/// Without this the parity suite diverges on boolean, null, and
/// integral-float substitutions: JS renders `null`, `true`, and `1` where a
/// naive Rust `to_string` would render `null`… but `1.0` for the float, and
/// serde's `Value::to_string` would render `"text"` **with quotes** for a
/// string.
///
/// Source: payload-resolution.ts (_js_string)
#[must_use]
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        // Strings render bare — `Value::to_string` would wrap them in quotes.
        Value::String(s) => s.clone(),
        Value::Number(n) => n.as_f64().map_or_else(
            || n.to_string(),
            |f| {
                if f.fract() == 0.0 && f.is_finite() {
                    // JS `String(1.0) === "1"`.
                    format!("{}", f as i64)
                } else {
                    n.to_string()
                }
            },
        ),
        other => other.to_string(),
    }
}

/// Rewrite token values through each token's `value_map`.
///
/// A token whose context value (JS-stringified) appears as a key in its
/// `value_map` is replaced by the mapped value. Absent/null context values and
/// tokens without a map are skipped.
///
/// Source: payload-resolution.ts:65-83
#[must_use]
pub fn apply_value_maps(context: &Map<String, Value>, tokens: &[Value]) -> Map<String, Value> {
    let mut enhanced = context.clone();
    for token_def in tokens {
        let Some(name) = token_def.get("token").and_then(Value::as_str) else {
            continue;
        };
        let Some(raw) = context.get(name).filter(|v| !v.is_null()) else {
            continue;
        };
        let Some(map) = token_def.get("value_map").and_then(Value::as_object) else {
            continue;
        };
        if let Some(mapped) = map.get(&js_string(raw)) {
            enhanced.insert(name.to_string(), mapped.clone());
        }
    }
    enhanced
}

/// Scan for the next `{{ name }}` starting at `from`.
///
/// Returns `(start, end, name)` with `end` exclusive. Implemented by hand
/// rather than with the `regex` crate: this is one fixed pattern, and a
/// published SDK should not carry `regex-automata` + `aho-corasick` for it.
/// The accepted shape is exactly `\{\{\s*([a-zA-Z0-9_]+)\s*\}\}`.
pub(crate) fn next_token(haystack: &str, from: usize) -> Option<(usize, usize, &str)> {
    let bytes = haystack.as_bytes();
    let mut i = from;

    while i + 1 < bytes.len() {
        if bytes[i] != b'{' || bytes[i + 1] != b'{' {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i + 2;

        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        let name_start = j;
        while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
            j += 1;
        }
        let name_end = j;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }

        // A name is required, and the braces must close.
        if name_end > name_start && j + 1 < bytes.len() && bytes[j] == b'}' && bytes[j + 1] == b'}'
        {
            return Some((start, j + 2, &haystack[name_start..name_end]));
        }
        // Not a token after all — resume scanning past this `{`.
        i += 1;
    }
    None
}

/// Substitute `{{token}}` placeholders from `context`.
///
/// Unknown names fall back to [`TOKEN_ALIASES`], then are **left verbatim** —
/// an unresolved token renders as its own `{{...}}` rather than as an empty
/// string, so a missing value is visible instead of silently blanking copy.
///
/// Source: payload-resolution.ts:88-104
#[must_use]
pub fn resolve_tokens(template: &str, context: &Map<String, Value>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut cursor = 0usize;

    while let Some((start, end, name)) = next_token(template, cursor) {
        out.push_str(&template[cursor..start]);

        let direct = context.get(name);
        let aliased = || {
            TOKEN_ALIASES
                .iter()
                .find(|(from, _)| *from == name)
                .and_then(|(_, to)| context.get(*to))
        };

        match direct.or_else(aliased) {
            Some(v) => out.push_str(&js_string(v)),
            // Unresolved — keep the literal `{{...}}`.
            None => out.push_str(&template[start..end]),
        }
        cursor = end;
    }

    out.push_str(&template[cursor..]);
    out
}

/// Resolve tokens in every **string** field of `content`; other values pass
/// through untouched.
///
/// Source: payload-resolution.ts:109-119
#[must_use]
pub fn resolve_content(
    content: &Map<String, Value>,
    context: &Map<String, Value>,
) -> Map<String, Value> {
    content
        .iter()
        .map(|(k, v)| {
            let resolved = match v {
                Value::String(s) => Value::String(resolve_tokens(s, context)),
                other => other.clone(),
            };
            (k.clone(), resolved)
        })
        .collect()
}

/// What segment matching decided for one payload.
struct SegmentMatch {
    block_id: String,
    matched_segment_id: Option<String>,
    ui_path_id: Option<String>,
    promotion_id: Option<String>,
    /// True only on the cross-dimension AND path when the user fails the
    /// condition — the caller must skip this payload entirely.
    skip: bool,
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Resolve which block a payload shows for this user.
///
/// Two modes:
///
/// - **Cross-dimension AND** (when `segment_dimensions` is supplied and the
///   entries carry `dimension`): the user must match ≥1 segment in *every*
///   dimension. Failing that skips the payload outright rather than falling
///   back to the default — a payload targeted at "enterprise AND trialing"
///   must not show to someone who is only one of those.
/// - **Flat OR** otherwise: the first matching entry wins.
///
/// Source: payload-resolution.ts:156-218
fn match_segment_content(
    payload: &Value,
    user_segments: &HashSet<String>,
    segment_dimensions: Option<&HashMap<String, Vec<String>>>,
) -> SegmentMatch {
    let mut m = SegmentMatch {
        block_id: payload
            .get("default_message_block_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        matched_segment_id: None,
        ui_path_id: str_of(payload, "ui_path_id"),
        promotion_id: str_of(payload, "promotion_id"),
        skip: false,
    };

    let Some(entries) = payload
        .get("segment_content_map")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
    else {
        return m;
    };

    let mut take = |entry: &Value| {
        if let Some(id) = entry.get("message_block_id").and_then(Value::as_str) {
            m.block_id = id.to_string();
        }
        m.matched_segment_id = str_of(entry, "segment_id");
        // Entry-level path/promotion override the payload's only when present.
        if let Some(p) = str_of(entry, "ui_path_id") {
            m.ui_path_id = Some(p);
        }
        if let Some(p) = str_of(entry, "promotion_id") {
            m.promotion_id = Some(p);
        }
    };

    let dimensioned = segment_dimensions.is_some_and(|d| !d.is_empty());
    if dimensioned {
        let mut by_dimension: HashMap<&str, Vec<&Value>> = HashMap::new();
        for e in entries {
            if let Some(dim) = e
                .get("dimension")
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
            {
                by_dimension.entry(dim).or_default().push(e);
            }
        }

        if !by_dimension.is_empty() {
            let mut all_match = true;
            let mut first: Option<&Value> = None;
            for dim_entries in by_dimension.values() {
                let hit = dim_entries.iter().find(|e| {
                    e.get("segment_id")
                        .and_then(Value::as_str)
                        .is_some_and(|s| user_segments.contains(s))
                });
                match hit {
                    Some(e) => {
                        if first.is_none() {
                            first = Some(e);
                        }
                    }
                    None => {
                        all_match = false;
                        break;
                    }
                }
            }

            if all_match {
                if let Some(e) = first {
                    take(e);
                }
            } else {
                m.skip = true;
            }
            return m;
        }
        // No dimension metadata on the entries — fall through to flat OR.
    }

    for e in entries {
        if e.get("segment_id")
            .and_then(Value::as_str)
            .is_some_and(|s| user_segments.contains(s))
        {
            take(e);
            break;
        }
    }
    m
}

/// Merge a block's `default_content` with a matching segment override.
///
/// When segment matching already chose a segment, that exact override is
/// honoured. Otherwise the first override whose segment the user holds wins —
/// which is what makes block-level overrides work in local mode, where
/// payloads carry a single block and no `segment_content_map`.
///
/// Source: payload-resolution.ts:223-231
fn apply_segment_overrides(
    block: &Value,
    matched_segment_id: Option<String>,
    user_segments: &HashSet<String>,
) -> (Map<String, Value>, Option<String>) {
    let mut content = block
        .get("default_content")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let Some(overrides) = block.get("segment_overrides").and_then(Value::as_array) else {
        return (content, matched_segment_id);
    };

    let found = match matched_segment_id.as_deref() {
        Some(id) => overrides
            .iter()
            .find(|o| o.get("segment_value_id").and_then(Value::as_str) == Some(id)),
        None => overrides.iter().find(|o| {
            o.get("segment_value_id")
                .and_then(Value::as_str)
                .is_some_and(|s| user_segments.contains(s))
        }),
    };

    let Some(over) = found else {
        return (content, matched_segment_id);
    };

    if let Some(patch) = over.get("content").and_then(Value::as_object) {
        for (k, v) in patch {
            content.insert(k.clone(), v.clone());
        }
    }
    let id = str_of(over, "segment_value_id").or(matched_segment_id);
    (content, id)
}

/// Resolve the best-matching **active** payload for a user and surface.
///
/// Candidates are filtered to the surface and to `status == "active"`, then
/// tried in authored order; the first that yields an active block wins. A
/// payload whose block is missing or inactive is skipped rather than
/// rendered empty.
///
/// Source: payload-resolution.ts:137-245
#[must_use]
pub fn resolve_payload_for_user(
    surface_template_id: &str,
    user_segment_ids: &[String],
    payloads: &[Value],
    blocks: &[Value],
    tokens: &[Value],
    personalization: &Map<String, Value>,
    segment_dimensions: Option<&HashMap<String, Vec<String>>>,
) -> Option<ResolvedPayload> {
    let candidates: Vec<&Value> = payloads
        .iter()
        .filter(|p| {
            p.get("surface_template_id").and_then(Value::as_str) == Some(surface_template_id)
                && p.get("status").and_then(Value::as_str) == Some("active")
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }

    let block_map: HashMap<&str, &Value> = blocks
        .iter()
        .filter(|b| b.is_object())
        .filter_map(|b| b.get("block_id").and_then(Value::as_str).map(|id| (id, b)))
        .collect();

    let user_segments: HashSet<String> = user_segment_ids.iter().cloned().collect();
    let enhanced = apply_value_maps(personalization, tokens);

    for payload in candidates {
        let m = match_segment_content(payload, &user_segments, segment_dimensions);
        if m.skip {
            continue;
        }

        let Some(block) = block_map.get(m.block_id.as_str()) else {
            continue;
        };
        if block.get("status").and_then(Value::as_str) != Some("active") {
            continue;
        }

        let (raw_content, matched_segment_id) =
            apply_segment_overrides(block, m.matched_segment_id, &user_segments);

        return Some(ResolvedPayload {
            payload: (*payload).clone(),
            message_block: (*block).clone(),
            resolved_content: resolve_content(&raw_content, &enhanced),
            matched_segment_id,
            ui_path_id: m.ui_path_id,
            promotion_id: m.promotion_id,
        });
    }

    None
}
