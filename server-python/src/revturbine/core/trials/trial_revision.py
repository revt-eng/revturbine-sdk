"""revturbine.core.trials.trial_revision — Python port of scaffold's
``src/trials/models/trial-revision.ts`` plus the server-port record surface
(plan 276 TASK-12/TASK-13, rulings R-1 / R-2; workspace ruling D-21).

Byte-faithful translation of the TypeScript classifier: same rule order, same
closed reason set, same output. Pure and **clock-free** — ``observed_through``
is supplied by the caller, and nothing here reads the current time. Parity =
Python ≡ TS ≡ Rust.

The port has no event-emit surface of its own and this module does not add one.
``record_trial_revision`` classifies an episode and returns the **validated
payload for the host to ship** through whatever transport it already uses
(``POST /api/track``, a queue, its own warehouse writer). That is deliberate:
a server SDK that opened its own network path to RevTurbine would be a second,
unversioned ingest client, and the ports have never had one. What the ports owe
is that the payload they hand back is byte-identical to the one the browser SDK
emits for the same facts, which is what the parity fixtures assert.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypedDict

TRIAL_REVISION_KINDS: tuple[str, ...] = (
    "started",
    "extended",
    "converted",
    "reverted",
    "expired",
    "revoked",
)

TRIAL_EVIDENCE_KINDS: tuple[str, ...] = ("provider_fact", "app_fact", "usage_exhaustion")

TRIAL_PENDING_UNKNOWN_REASONS: tuple[str, ...] = (
    "no_authoritative_fact",
    "elapsed_deadline_without_fact",
    "episode_open",
    "usage_expiry_requires_exhaustion_evidence",
    "commitment_precedes_actual_end",
    "end_evidence_without_effective_time",
)

#: Sources naming a USER-grain act. Plan 276 R-2: a user signup does not
#: establish account creation, and neither does a first observation.
USER_GRAIN_SIGNUP_SOURCES: tuple[str, ...] = ("user_signup", "user_signed_up", "first_seen")


class TrialEvidence(TypedDict):
    """A reference to the fact that proved something. Opaque to RevTurbine."""

    kind: str
    ref: str
    occurred_at: str


def _evidence(value: Any) -> Mapping[str, Any] | None:
    """An evidence mapping, or ``None`` for anything that is not one."""
    if not isinstance(value, Mapping):
        return None
    if not isinstance(value.get("ref"), str) or not isinstance(value.get("kind"), str):
        return None
    return value


def _at_or_after(a: str, b: str) -> bool:
    """Lexicographic comparison is correct for ISO-8601 UTC instants."""
    return a >= b


def _grants_account(facts: Mapping[str, Any]) -> bool:
    return facts.get("subject_scope") == "account"


def _pending(reason: str, facts: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "status": "pending_unknown",
        "reason": reason,
        "grants_account_access": _grants_account(facts),
    }


def _resolved(
    revision: str,
    effective_at: str,
    evidence: Mapping[str, Any],
    facts: Mapping[str, Any],
    commitment_ref: str | None = None,
) -> dict[str, Any]:
    return {
        "status": "revision",
        "revision": revision,
        "effective_at": effective_at,
        "evidence": {
            "kind": evidence["kind"],
            "ref": evidence["ref"],
            "occurred_at": evidence["occurred_at"],
        },
        "grants_account_access": _grants_account(facts),
        "commitment_ref": commitment_ref,
    }


def classify_trial_revision(facts: Mapping[str, Any]) -> dict[str, Any]:
    """Classify one trial episode's facts into the revision they support.

    Pure, clock-free and total: every input resolves to either
    ``{"status": "revision", ...}`` or ``{"status": "pending_unknown", ...}``.
    """
    revocation = _evidence(facts.get("revocation"))
    if revocation is not None:
        return _resolved("revoked", revocation["occurred_at"], revocation, facts)

    enrollment = _evidence(facts.get("enrollment"))
    if enrollment is None:
        return _pending("no_authoritative_fact", facts)

    end_evidence = _evidence(facts.get("end_evidence"))
    actual_end_at = facts.get("actual_end_at")
    closed = end_evidence is not None or actual_end_at is not None

    if not closed:
        extension = _evidence(facts.get("extension"))
        if extension is not None:
            return _resolved("extended", extension["occurred_at"], extension, facts)
        deadline = facts.get("scheduled_end_at")
        observed = facts.get("observed_through")
        if (
            isinstance(deadline, str)
            and isinstance(observed, str)
            and _at_or_after(observed, deadline)
        ):
            # R-1(c): the deadline passed and nothing said the app ended
            # anything. No edge is emitted.
            return _pending("elapsed_deadline_without_fact", facts)
        started_at = facts.get("started_at")
        if isinstance(started_at, str):
            return _resolved("started", started_at, enrollment, facts)
        return _pending("episode_open", facts)

    if end_evidence is None:
        return _pending("end_evidence_without_effective_time", facts)
    resolved_end = actual_end_at if isinstance(actual_end_at, str) else end_evidence["occurred_at"]

    # A conversion links ONLY its own episode's commitment, at or after the
    # evidenced end (plan 276 AC-4).
    commitment = facts.get("commitment")
    if isinstance(commitment, Mapping) and commitment.get("trial_episode_id") == facts.get(
        "trial_episode_id"
    ):
        started = commitment.get("started_at")
        if isinstance(started, str) and _at_or_after(started, resolved_end):
            return _resolved("converted", started, end_evidence, facts, commitment.get("ref"))
        return _pending("commitment_precedes_actual_end", facts)

    if facts.get("limit_type") == "usage":
        exhaustion = _evidence(facts.get("exhaustion"))
        if exhaustion is None and end_evidence["kind"] == "usage_exhaustion":
            exhaustion = end_evidence
        if exhaustion is None:
            return _pending("usage_expiry_requires_exhaustion_evidence", facts)
        effective = actual_end_at if isinstance(actual_end_at, str) else exhaustion["occurred_at"]
        return _resolved("expired", effective, exhaustion, facts)

    fallback = _evidence(facts.get("fallback"))
    if fallback is not None:
        return _resolved("reverted", fallback["occurred_at"], fallback, facts)
    return _resolved("expired", resolved_end, end_evidence, facts)


def build_trial_revision_payload(
    facts: Mapping[str, Any],
    classification: Mapping[str, Any],
    labels: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Translate an episode plus a verdict into the ``trial_revision`` payload.

    Returns ``None`` when the verdict supports no revision — which is the
    instruction to emit nothing.
    """
    if classification.get("status") != "revision":
        return None
    lbl: Mapping[str, Any] = labels or {}
    return {
        "trial_episode_id": facts["trial_episode_id"],
        "account_id": facts["account_id"],
        "subject_scope": facts["subject_scope"],
        "rule_handle": lbl.get("rule_handle"),
        "plan_handle": lbl.get("plan_handle"),
        "trial_type": lbl.get("trial_type"),
        "revision": classification["revision"],
        "effective_at": classification["effective_at"],
        "scheduled_end_at": facts.get("scheduled_end_at"),
        "actual_end_at": facts.get("actual_end_at"),
        "evidence": {
            "kind": classification["evidence"]["kind"],
            "ref": classification["evidence"]["ref"],
        },
        "provider_ref": lbl.get("provider_ref"),
    }


def record_trial_revision(
    facts: Mapping[str, Any],
    labels: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Classify one episode and return the payload the host should ship.

    The Python port has no event transport of its own, so this **records
    nothing itself**: ``status`` is ``"payload_ready"`` with a ``payload`` the
    host sends through its existing ingest path, or ``"pending_unknown"`` with
    ``payload: None`` and nothing to send. Trial execution and ownership stay
    with the customer app.
    """
    classification = classify_trial_revision(facts)
    payload = build_trial_revision_payload(facts, classification, labels)
    return {
        "status": "payload_ready" if payload is not None else "pending_unknown",
        "classification": classification,
        "payload": payload,
    }


def record_account_created(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Validate an ``account_created`` payload and return it for the host to ship.

    Refuses a user-grain source: plan 276 R-2 says a user signup is not account
    creation. Refuses a payload missing the account grain, the creation time or
    the evidence — REQ-3 requires all three.
    """
    source = payload.get("source")
    if isinstance(source, str) and source in USER_GRAIN_SIGNUP_SOURCES:
        return {
            "status": "refused",
            "reason": "user_grain_signup_is_not_account_creation",
            "payload": None,
        }
    for field, reason in (
        ("source", "unrecognized_source"),
        ("evidence", "no_evidence"),
        ("account_id", "no_account_grain"),
        ("created_at", "no_creation_time"),
    ):
        if not payload.get(field):
            return {"status": "refused", "reason": reason, "payload": None}
    out: dict[str, Any] = {
        "account_id": payload["account_id"],
        "created_at": payload["created_at"],
        "source": payload["source"],
        "evidence": {
            "kind": payload["evidence"]["kind"],
            "ref": payload["evidence"]["ref"],
        },
    }
    if payload.get("acquisition_source"):
        out["acquisition_source"] = payload["acquisition_source"]
    return {"status": "payload_ready", "reason": None, "payload": out}


__all__ = [
    "TRIAL_REVISION_KINDS",
    "TRIAL_EVIDENCE_KINDS",
    "TRIAL_PENDING_UNKNOWN_REASONS",
    "USER_GRAIN_SIGNUP_SOURCES",
    "TrialEvidence",
    "classify_trial_revision",
    "build_trial_revision_payload",
    "record_trial_revision",
    "record_account_created",
]
