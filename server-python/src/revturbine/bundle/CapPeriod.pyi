from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class CapPeriod(object):
  unknown = cast(int, ...)
  session = cast(int, ...)
  day = cast(int, ...)
  week = cast(int, ...)
  month = cast(int, ...)
  lifetime = cast(int, ...)

