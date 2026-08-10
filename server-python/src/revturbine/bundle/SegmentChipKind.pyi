from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class SegmentChipKind(object):
  unknown = cast(int, ...)
  segment = cast(int, ...)
  plan = cast(int, ...)
  literal = cast(int, ...)

