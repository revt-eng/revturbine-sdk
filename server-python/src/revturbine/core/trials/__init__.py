"""revturbine.core.trials — Python port of
`@revt-eng/core/trials` (scaffold ``src/trials/controllers/``).

Byte-faithful translation of ``trial-status.ts`` — derives the runtime
``UserTrialStatus`` from ``TrialInstance`` records + trial rules, and
evaluates a Playbook's ``free_trial_rules`` / ``reverse_trial_rules``
arrays directly (:func:`evaluate_trial_status`). Pure + deterministic;
parity = Python ≡ TS.
"""

from revturbine.core.trials.trial_status import (
    derive_local_trial_status_from_instance,
    derive_reverse_trial_grants,
    evaluate_trial_status,
    find_active_trial_instance,
    find_latest_started_trial_instance,
)

__all__ = [
    "derive_local_trial_status_from_instance",
    "derive_reverse_trial_grants",
    "evaluate_trial_status",
    "find_active_trial_instance",
    "find_latest_started_trial_instance",
]
