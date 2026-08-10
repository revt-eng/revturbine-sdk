from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class EntitlementType(object):
  unknown = cast(int, ...)
  feature = cast(int, ...)
  usage_limit = cast(int, ...)
  credits = cast(int, ...)
  seats = cast(int, ...)
  tiered = cast(int, ...)

