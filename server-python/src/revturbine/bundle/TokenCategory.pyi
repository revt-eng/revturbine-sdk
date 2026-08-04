from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class TokenCategory(object):
  unknown = cast(int, ...)
  user = cast(int, ...)
  plan = cast(int, ...)
  usage = cast(int, ...)
  trial = cast(int, ...)
  billing = cast(int, ...)
  promotion = cast(int, ...)
  custom = cast(int, ...)

