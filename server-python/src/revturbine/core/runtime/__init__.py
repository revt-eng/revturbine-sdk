"""revturbine.core.runtime — Python port of `@revt-eng/core/runtime/`.

Mirrors the TS module layout one-to-one for parity-review tractability:

- ``local_runtime`` — ``LocalRuntime``: the standard composition of the
  ported core subsystems (provider registry + decision engine +
  interaction tracker + cap enforcer + impression history + static
  placement resolver) for local-only, in-process placement and
  entitlement decisioning with zero network calls.
"""

from revturbine.core.runtime.local_runtime import (
    LocalRuntime,
    LocalRuntimeInteractionOptions,
)

__all__ = [
    "LocalRuntime",
    "LocalRuntimeInteractionOptions",
]
