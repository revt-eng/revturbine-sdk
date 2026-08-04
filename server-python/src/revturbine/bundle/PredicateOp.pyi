from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class PredicateOp(object):
  unknown = cast(int, ...)
  eq = cast(int, ...)
  neq = cast(int, ...)
  gt = cast(int, ...)
  lt = cast(int, ...)
  gte = cast(int, ...)
  lte = cast(int, ...)
  contains = cast(int, ...)
  in_ = cast(int, ...)

