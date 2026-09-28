"""revturbine.core.adapters — Python port of @revt-eng/core/adapters/.

Builds domain providers from a config source. ``static`` is the
local-mode path (an ``ExportedConfig`` snapshot); hydration/API
adapters are HTTP-mode concerns deferred to a later TASK-7 batch.
"""

from revturbine.core.adapters.static import (
    apply_server_builtin_dimensions,
    create_static_providers,
)
from revturbine.core.adapters.types import AdapterBaseOptions

__all__ = [
    "AdapterBaseOptions",
    "apply_server_builtin_dimensions",
    "create_static_providers",
]
