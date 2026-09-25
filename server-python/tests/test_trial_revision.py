"""The Python port's trial-revision and account-creation record surface
(plan 276 TASK-13 / BL-0237, ruling D-21).

The classifier's cross-language agreement is asserted by the
``trial_revision_classification`` parity fixture, which runs the same corpus
through ts/py/rs and diffs the output byte-for-byte. What is asserted here is
what the fixture cannot reach: that the port **records nothing itself** (it
returns a payload for the host to ship), and ``record_account_created``, which
has no parity fixture because it is pure validation rather than classification.
"""

from __future__ import annotations

from revturbine.core.trials import (
    classify_trial_revision,
    record_account_created,
    record_trial_revision,
)

_ENROLLED = {
    "kind": "app_fact",
    "ref": "write_1",
    "occurred_at": "2026-09-01T00:00:00.000Z",
}


def _open_episode(**overrides: object) -> dict[str, object]:
    facts: dict[str, object] = {
        "trial_episode_id": "app:acct_1:reverse:1",
        "account_id": "acct_1",
        "subject_scope": "account",
        "limit_type": "time",
        "enrollment": _ENROLLED,
        "started_at": "2026-09-01T00:00:00.000Z",
        "scheduled_end_at": "2026-09-15T00:00:00.000Z",
        "actual_end_at": None,
        "end_evidence": None,
        "extension": None,
        "revocation": None,
        "commitment": None,
        "fallback": None,
        "exhaustion": None,
        "observed_through": "2026-09-05T00:00:00.000Z",
    }
    facts.update(overrides)
    return facts


class TestRecordTrialRevision:
    def test_returns_a_payload_for_the_host_to_ship_rather_than_emitting(self) -> None:
        ended = _open_episode(
            actual_end_at="2026-09-15T00:00:00.000Z",
            end_evidence={
                "kind": "app_fact",
                "ref": "write_end",
                "occurred_at": "2026-09-15T00:00:00.000Z",
            },
            observed_through="2026-09-20T00:00:00.000Z",
        )
        result = record_trial_revision(ended, {"rule_handle": "reverse_14d"})
        assert result["status"] == "payload_ready"
        assert result["payload"]["revision"] == "expired"
        assert result["payload"]["effective_at"] == "2026-09-15T00:00:00.000Z"
        assert result["payload"]["rule_handle"] == "reverse_14d"
        assert result["payload"]["evidence"] == {"kind": "app_fact", "ref": "write_end"}

    def test_an_elapsed_deadline_yields_no_payload(self) -> None:
        result = record_trial_revision(_open_episode(observed_through="2026-10-30T00:00:00.000Z"))
        assert result["status"] == "pending_unknown"
        assert result["payload"] is None
        assert result["classification"]["reason"] == "elapsed_deadline_without_fact"

    def test_the_labels_default_to_null_rather_than_being_omitted(self) -> None:
        ended = _open_episode(
            actual_end_at="2026-09-15T00:00:00.000Z",
            end_evidence={
                "kind": "app_fact",
                "ref": "write_end",
                "occurred_at": "2026-09-15T00:00:00.000Z",
            },
        )
        payload = record_trial_revision(ended)["payload"]
        for key in ("rule_handle", "plan_handle", "trial_type", "provider_ref"):
            assert key in payload
            assert payload[key] is None

    def test_classify_is_clock_free(self) -> None:
        """No observation window at all is `started`, not expired: nothing here
        consults the wall clock to decide an episode ended."""
        result = classify_trial_revision(_open_episode(observed_through=None))
        assert result == {
            "status": "revision",
            "revision": "started",
            "effective_at": "2026-09-01T00:00:00.000Z",
            "evidence": _ENROLLED,
            "grants_account_access": True,
            "commitment_ref": None,
        }


class TestRecordAccountCreated:
    _EVIDENCED = {
        "account_id": "acct_1",
        "created_at": "2026-09-01T00:00:00.000Z",
        "source": "self_serve_signup",
        "evidence": {"kind": "app_fact", "ref": "write_acct_1"},
    }

    def test_accepts_the_evidenced_shape(self) -> None:
        result = record_account_created(self._EVIDENCED)
        assert result["status"] == "payload_ready"
        assert result["payload"]["account_id"] == "acct_1"

    def test_refuses_a_user_grain_source(self) -> None:
        result = record_account_created({**self._EVIDENCED, "source": "user_signup"})
        assert result == {
            "status": "refused",
            "reason": "user_grain_signup_is_not_account_creation",
            "payload": None,
        }

    def test_refuses_a_first_observation(self) -> None:
        result = record_account_created({**self._EVIDENCED, "source": "first_seen"})
        assert result["reason"] == "user_grain_signup_is_not_account_creation"

    def test_refuses_an_unevidenced_claim(self) -> None:
        result = record_account_created({**self._EVIDENCED, "evidence": None})
        assert result == {"status": "refused", "reason": "no_evidence", "payload": None}

    def test_refuses_a_claim_with_no_account_grain(self) -> None:
        result = record_account_created({**self._EVIDENCED, "account_id": None})
        assert result["reason"] == "no_account_grain"

    def test_carries_an_optional_acquisition_source(self) -> None:
        result = record_account_created({**self._EVIDENCED, "acquisition_source": "organic"})
        assert result["payload"]["acquisition_source"] == "organic"
