from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class TokenFormat(object):
  unknown = cast(int, ...)
  string_ = cast(int, ...)
  number = cast(int, ...)
  currency = cast(int, ...)
  percentage = cast(int, ...)
  date = cast(int, ...)

