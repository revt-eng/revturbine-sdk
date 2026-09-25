"""Account-identity fallback contract — port of ``web-sdk/account-identity.ts``.

BL-0117, Kent's ruling **D-13** (2026-09-25): *"Keep the user-id fallback but
explicitly prefix it to make it obvious its a fallback key."*

``events_clickstream.account_id`` and ``placement_presentations.account_id`` are
analytical **join keys**: ``monetization_funnel`` and ``cohort_rollup`` build
their account map out of them, and every experiment summary pipe reads them
whenever ``analysis_unit='account'``. A producer that has no identified account
must therefore either omit the key (valid on the wire — ``TrackEvent.account_id``
is optional as of ``@revt-eng/schema`` 0.1.325) or send a key that is
**unmistakably fabricated**. A bare user id is neither: it looks exactly like a
real account and silently turns an account-grain readout into a user-grain one.

This module is the byte-level contract for the fabricated form. It is a pure
mirror of the TypeScript module of the same name and is covered by the
cross-language parity corpus (``tests/parity/fixtures/account_id_fallback_prefix.json``),
so the prefix cannot drift between ports.
"""

__all__ = [
    "FALLBACK_ACCOUNT_ID_PREFIX",
    "fallback_account_id",
    "is_fallback_account_id",
]

#: Namespace marker in front of an ``account_id`` derived from a user id
#: because no account was identified. Stable wire contract — analytics
#: read-time guards match on this literal, so changing it is a breaking change
#: to every pipe that filters on it.
FALLBACK_ACCOUNT_ID_PREFIX = "user-fallback:"


def fallback_account_id(user_id: str) -> str:
    """Build the fallback account key for ``user_id``.

    The id is used verbatim: redaction and trimming belong to the caller, which
    already resolved the ``user_id`` it is about to put on the same wire row.
    Deriving the key from a different normalization is how two lanes stop
    joining.
    """
    return f"{FALLBACK_ACCOUNT_ID_PREFIX}{user_id}"


def is_fallback_account_id(account_id: str | None) -> bool:
    """Whether ``account_id`` was fabricated from a user id.

    ``None`` and the bare prefix with nothing after it are **not** fallback
    keys — the first is absence and the second is not a key at all.
    """
    if not isinstance(account_id, str):
        return False
    return account_id.startswith(FALLBACK_ACCOUNT_ID_PREFIX) and len(account_id) > len(
        FALLBACK_ACCOUNT_ID_PREFIX
    )
