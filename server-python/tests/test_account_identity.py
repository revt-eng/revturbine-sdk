"""The account-identity fallback contract — BL-0117 / Kent's ruling D-13.

Pure string functions, so the assertions that matter are about the LITERAL:
``monetization_funnel`` and ``cohort_rollup`` exclude fallback-prefixed ids from
their account denominators by matching this exact marker at read time, and the
same marker is re-implemented in ``web-sdk`` and ``server-rust`` (locked
cross-language by ``tests/parity/fixtures/account_id_fallback_prefix.json``). A
drift in casing, separator, or match position puts fabricated keys back into a
real-account count — silently, which is how BL-0117 survived as long as it did.
"""

from revturbine.core.account_identity import (
    FALLBACK_ACCOUNT_ID_PREFIX,
    fallback_account_id,
    is_fallback_account_id,
)


def test_prefix_is_the_exact_literal_the_warehouse_guards_match_on() -> None:
    assert FALLBACK_ACCOUNT_ID_PREFIX == "user-fallback:"


def test_prefixes_the_user_id_verbatim() -> None:
    assert fallback_account_id("user_1") == "user-fallback:user_1"
    # An already-redacted identity key passes through untouched: redaction
    # belongs to the caller, which already resolved the user_id on this row.
    assert fallback_account_id("h_7f3c9a1b") == "user-fallback:h_7f3c9a1b"


def test_does_not_trim_lowercase_or_reencode() -> None:
    assert fallback_account_id(" user 1 ") == "user-fallback: user 1 "
    assert fallback_account_id("User_ONE") == "user-fallback:User_ONE"


def test_round_trips_through_its_own_classifier() -> None:
    assert is_fallback_account_id(fallback_account_id("anon_abc")) is True


def test_classifies_fabricated_keys_only() -> None:
    assert is_fallback_account_id("user-fallback:user_1") is True
    # The case that keeps real accounts IN the denominator.
    assert is_fallback_account_id("acct_acme") is False
    # The bare prefix carries no identity, so it is not a key.
    assert is_fallback_account_id(FALLBACK_ACCOUNT_ID_PREFIX) is False
    assert is_fallback_account_id("") is False
    assert is_fallback_account_id(None) is False


def test_matches_at_the_start_only_and_is_case_sensitive() -> None:
    # A substring match would drop every real account whose id embeds the
    # marker; a case-insensitive one would diverge from the SQL guards.
    assert is_fallback_account_id("acct_user-fallback:x") is False
    assert is_fallback_account_id("USER-FALLBACK:user_1") is False
