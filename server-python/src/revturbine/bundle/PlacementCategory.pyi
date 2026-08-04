from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class PlacementCategory(object):
  unknown = cast(int, ...)
  fixed = cast(int, ...)
  gated = cast(int, ...)
  usage_credit_seat = cast(int, ...)
  trials = cast(int, ...)
  other_conversion = cast(int, ...)
  retention = cast(int, ...)

