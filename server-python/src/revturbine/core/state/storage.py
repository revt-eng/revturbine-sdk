"""Storage abstraction — Python port of @revt-eng/core/state/storage.ts.

Provides a pluggable interface that works in any Python context.
``InMemoryStorage`` is the default; downstream callers can plug in a
file-backed or DB-backed implementation by satisfying the
``RevTurbineStorage`` protocol.

``JsonFileStorage`` is Python-specific: the TS ``storage.ts`` only adds
a browser ``BrowserStorage`` (``localStorage``/``sessionStorage``),
which is out of scope for the Python port per plan 33 REQ-14
(browser-only). Python local-mode services that gate across process
restarts (gunicorn/uvicorn workers, Celery, cron) need durable
interaction/cap state, so a thin JSON-file backend fills that role.

Source: revturbine-scaffold/src/core/state/storage.ts
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
from pathlib import Path
from typing import Protocol, runtime_checkable

__all__ = ["InMemoryStorage", "JsonFileStorage", "RevTurbineStorage"]


@runtime_checkable
class RevTurbineStorage(Protocol):
    """Minimal storage interface mirroring the TS Web Storage API subset.

    Source: storage.ts:17-21
    """

    def get_item(self, key: str) -> str | None: ...
    def set_item(self, key: str, value: str) -> None: ...
    def remove_item(self, key: str) -> None: ...


class InMemoryStorage:
    """Process-local Map-backed storage. Data does not persist beyond the
    current Python process.

    Source: storage.ts:29-43
    """

    def __init__(self) -> None:
        self._store: dict[str, str] = {}

    def get_item(self, key: str) -> str | None:
        return self._store.get(key)

    def set_item(self, key: str, value: str) -> None:
        self._store[key] = value

    def remove_item(self, key: str) -> None:
        self._store.pop(key, None)


class JsonFileStorage:
    """File-backed storage that persists across Python processes.

    The whole key/value map is held in memory and the backing file is a
    single JSON object rewritten atomically on every mutation (write to
    a sibling temp file, then ``os.replace`` — atomic on POSIX and
    Windows). The map is loaded once on construction; a missing,
    unreadable, or malformed file yields an empty map rather than an
    error, mirroring the swallow-on-error resilience of the TS
    ``BrowserStorage`` (``storage.ts:18-45``) — a degraded storage
    backend must never crash decisioning.

    Not a port of any TS symbol: ``BrowserStorage`` is browser-only and
    explicitly out of scope (plan 33 REQ-14). Stdlib only (plan 33
    REQ-12). Single-process-at-a-time durability; concurrent writers on
    the same path are out of scope (use a real KV store for that).

    Source: Python-specific; resilience modeled on storage.ts:18-45.
    """

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self._path = Path(path)
        self._store: dict[str, str] = self._load()

    def _load(self) -> dict[str, str]:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except OSError:
            return {}
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {str(k): str(v) for k, v in data.items()}

    def _flush(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(
                prefix=f".{self._path.name}.",
                suffix=".tmp",
                dir=str(self._path.parent),
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(self._store, fh, separators=(",", ":"), sort_keys=True)
                os.replace(tmp, self._path)
            except OSError:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
        except OSError:
            # Swallow — a non-writable path degrades to in-memory-only
            # for this process rather than breaking the caller.
            pass

    def get_item(self, key: str) -> str | None:
        return self._store.get(key)

    def set_item(self, key: str, value: str) -> None:
        self._store[key] = value
        self._flush()

    def remove_item(self, key: str) -> None:
        if self._store.pop(key, None) is not None:
            self._flush()
