"""revturbine.core.state — Python port of `@revt-eng/core/state/`.

Mirrors the TS module layout one-to-one for parity-review tractability:

- ``storage`` — ``RevTurbineStorage`` protocol + ``InMemoryStorage`` +
  ``JsonFileStorage`` (Python-specific cross-process persistence).
- ``types`` — interaction / cap / suppression value types.
- ``interaction`` — pure helpers (``interaction_state_key``,
  ``suppression_for_state``).
- ``interaction_tracker`` — ``InteractionTracker`` stateful class.
- ``cap_enforcer`` — ``CapEnforcer`` stateful class.
- ``impression_history`` — ``ImpressionHistory`` + record types.
- ``impression_history_stores`` — ``InMemoryImpressionStore``,
  ``StorageImpressionStore``.
"""

from revturbine.core.state.cap_enforcer import CapEnforcer, CapEnforcerOptions
from revturbine.core.state.impression_history import (
    DEFAULT_SUPPRESSION_MS,
    ImpressionHistory,
    ImpressionHistoryOptions,
)
from revturbine.core.state.impression_history_stores import (
    InMemoryImpressionStore,
    StorageImpressionStore,
)
from revturbine.core.state.impression_history_types import (
    TERMINAL_OUTCOMES,
    ImpressionHistoryStore,
    ImpressionOutcome,
    ImpressionQuery,
    ImpressionRecord,
)
from revturbine.core.state.interaction import (
    interaction_state_key,
    suppression_for_state,
)
from revturbine.core.state.interaction_tracker import (
    InteractionTracker,
    InteractionTrackerOptions,
)
from revturbine.core.state.storage import (
    InMemoryStorage,
    JsonFileStorage,
    RevTurbineStorage,
)
from revturbine.core.state.types import (
    CapEnforcementResult,
    InteractionState,
    PlacementCapPolicy,
    PresentationCapState,
    RevTurbineTreatmentInteractionInput,
    RevTurbineTreatmentInteractionType,
    SuppressionResult,
    SurfaceTypeCapRule,
)

__all__ = [
    "DEFAULT_SUPPRESSION_MS",
    "TERMINAL_OUTCOMES",
    "CapEnforcementResult",
    "CapEnforcer",
    "CapEnforcerOptions",
    "ImpressionHistory",
    "ImpressionHistoryOptions",
    "ImpressionHistoryStore",
    "ImpressionOutcome",
    "ImpressionQuery",
    "ImpressionRecord",
    "InMemoryImpressionStore",
    "InMemoryStorage",
    "InteractionState",
    "InteractionTracker",
    "InteractionTrackerOptions",
    "JsonFileStorage",
    "PlacementCapPolicy",
    "PresentationCapState",
    "RevTurbineStorage",
    "RevTurbineTreatmentInteractionInput",
    "RevTurbineTreatmentInteractionType",
    "StorageImpressionStore",
    "SuppressionResult",
    "SurfaceTypeCapRule",
    "interaction_state_key",
    "suppression_for_state",
]
