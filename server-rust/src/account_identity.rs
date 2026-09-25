//! Account-identity fallback contract — port of `web-sdk/account-identity.ts`
//! and `revturbine.core.account_identity`.
//!
//! BL-0117, Kent's ruling **D-13** (2026-09-25): *"Keep the user-id fallback
//! but explicitly prefix it to make it obvious its a fallback key."*
//!
//! `events_clickstream.account_id` and `placement_presentations.account_id` are
//! analytical **join keys**: `monetization_funnel` and `cohort_rollup` build
//! their account map out of them, and every experiment summary pipe reads them
//! whenever `analysis_unit='account'`. A producer with no identified account
//! must either omit the key (valid on the wire — `TrackEvent.account_id` is
//! optional as of `@revt-eng/schema` 0.1.325) or send one that is
//! **unmistakably fabricated**. A bare user id is neither: it looks exactly
//! like a real account and silently turns an account-grain readout into a
//! user-grain one.
//!
//! The cross-language parity corpus
//! (`tests/parity/fixtures/account_id_fallback_prefix.json`) drives all three
//! ports through these functions, so the prefix cannot drift.

/// Namespace marker in front of an `account_id` derived from a user id because
/// no account was identified.
///
/// Stable wire contract: analytics read-time guards match on this literal, so
/// changing it is a breaking change to every pipe that filters on it.
pub const FALLBACK_ACCOUNT_ID_PREFIX: &str = "user-fallback:";

/// Build the fallback account key for `user_id`.
///
/// The id is used verbatim: redaction and trimming belong to the caller, which
/// already resolved the `user_id` it is about to put on the same wire row.
/// Deriving the key from a different normalization is how two lanes stop
/// joining.
#[must_use]
pub fn fallback_account_id(user_id: &str) -> String {
    format!("{FALLBACK_ACCOUNT_ID_PREFIX}{user_id}")
}

/// Whether `account_id` was fabricated from a user id.
///
/// The bare prefix with nothing after it is **not** a fallback key — it is not
/// a key at all.
#[must_use]
pub fn is_fallback_account_id(account_id: &str) -> bool {
    account_id.starts_with(FALLBACK_ACCOUNT_ID_PREFIX)
        && account_id.len() > FALLBACK_ACCOUNT_ID_PREFIX.len()
}

#[cfg(test)]
mod tests {
    use super::{fallback_account_id, is_fallback_account_id, FALLBACK_ACCOUNT_ID_PREFIX};

    #[test]
    fn prefixes_the_user_id_verbatim() {
        assert_eq!(fallback_account_id("user_1"), "user-fallback:user_1");
        // An already-hashed identity key passes through untouched — the caller
        // redacts, this function only namespaces.
        assert_eq!(fallback_account_id("h_abc123"), "user-fallback:h_abc123");
    }

    #[test]
    fn classifies_fabricated_keys_only() {
        assert!(is_fallback_account_id("user-fallback:user_1"));
        assert!(!is_fallback_account_id("acct_acme"));
        assert!(!is_fallback_account_id(""));
        // The bare prefix carries no identity, so it is not a key.
        assert!(!is_fallback_account_id(FALLBACK_ACCOUNT_ID_PREFIX));
        // Case- and position-sensitive: a real account id that merely CONTAINS
        // the marker is not fabricated.
        assert!(!is_fallback_account_id("acct_user-fallback:x"));
        assert!(!is_fallback_account_id("USER-FALLBACK:user_1"));
    }
}
