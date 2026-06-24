"""Tests for ``revturbine.core.state.storage``."""

from __future__ import annotations

import json
from pathlib import Path

from revturbine.core.state.storage import (
    InMemoryStorage,
    JsonFileStorage,
    RevTurbineStorage,
)


class TestInMemoryStorage:
    def test_get_missing_returns_none(self) -> None:
        storage = InMemoryStorage()
        assert storage.get_item("missing") is None

    def test_set_then_get(self) -> None:
        storage = InMemoryStorage()
        storage.set_item("k", "v")
        assert storage.get_item("k") == "v"

    def test_overwrite(self) -> None:
        storage = InMemoryStorage()
        storage.set_item("k", "v1")
        storage.set_item("k", "v2")
        assert storage.get_item("k") == "v2"

    def test_remove(self) -> None:
        storage = InMemoryStorage()
        storage.set_item("k", "v")
        storage.remove_item("k")
        assert storage.get_item("k") is None

    def test_remove_missing_is_noop(self) -> None:
        storage = InMemoryStorage()
        storage.remove_item("missing")  # No raise.

    def test_satisfies_protocol(self) -> None:
        storage = InMemoryStorage()
        assert isinstance(storage, RevTurbineStorage)


class TestJsonFileStorage:
    def test_set_then_get(self, tmp_path: Path) -> None:
        storage = JsonFileStorage(tmp_path / "s.json")
        storage.set_item("k", "v")
        assert storage.get_item("k") == "v"

    def test_get_missing_returns_none(self, tmp_path: Path) -> None:
        storage = JsonFileStorage(tmp_path / "s.json")
        assert storage.get_item("missing") is None

    def test_remove(self, tmp_path: Path) -> None:
        storage = JsonFileStorage(tmp_path / "s.json")
        storage.set_item("k", "v")
        storage.remove_item("k")
        assert storage.get_item("k") is None

    def test_remove_missing_is_noop(self, tmp_path: Path) -> None:
        JsonFileStorage(tmp_path / "s.json").remove_item("missing")  # No raise.

    def test_persists_across_instances(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        JsonFileStorage(path).set_item("k", "v")
        # A fresh instance on the same path must see the prior write —
        # the cross-process durability JsonFileStorage exists to provide.
        assert JsonFileStorage(path).get_item("k") == "v"

    def test_remove_persists_across_instances(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        first = JsonFileStorage(path)
        first.set_item("a", "1")
        first.set_item("b", "2")
        first.remove_item("a")
        reloaded = JsonFileStorage(path)
        assert reloaded.get_item("a") is None
        assert reloaded.get_item("b") == "2"

    def test_creates_parent_directories(self, tmp_path: Path) -> None:
        storage = JsonFileStorage(tmp_path / "nested" / "deep" / "s.json")
        storage.set_item("k", "v")
        assert (tmp_path / "nested" / "deep" / "s.json").is_file()

    def test_missing_file_loads_empty(self, tmp_path: Path) -> None:
        # Construction against a non-existent path must not raise.
        assert JsonFileStorage(tmp_path / "absent.json").get_item("k") is None

    def test_corrupt_file_loads_empty(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        path.write_text("{not valid json", encoding="utf-8")
        # Resilience parity with TS BrowserStorage swallow-on-error: a
        # malformed backing file degrades to empty, never raises.
        storage = JsonFileStorage(path)
        assert storage.get_item("k") is None
        storage.set_item("k", "v")  # Still writable afterwards.
        assert JsonFileStorage(path).get_item("k") == "v"

    def test_non_dict_json_loads_empty(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        path.write_text("[1, 2, 3]", encoding="utf-8")
        assert JsonFileStorage(path).get_item("0") is None

    def test_backing_file_is_valid_json(self, tmp_path: Path) -> None:
        path = tmp_path / "s.json"
        storage = JsonFileStorage(path)
        storage.set_item("k", "v")
        # Atomic write must always leave a parseable JSON object.
        assert json.loads(path.read_text(encoding="utf-8")) == {"k": "v"}

    def test_accepts_str_path(self, tmp_path: Path) -> None:
        storage = JsonFileStorage(str(tmp_path / "s.json"))
        storage.set_item("k", "v")
        assert storage.get_item("k") == "v"

    def test_satisfies_protocol(self, tmp_path: Path) -> None:
        assert isinstance(JsonFileStorage(tmp_path / "s.json"), RevTurbineStorage)
