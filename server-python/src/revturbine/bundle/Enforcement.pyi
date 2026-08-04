from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class Enforcement(object):
  unknown = cast(int, ...)
  hard_block = cast(int, ...)
  soft_warn = cast(int, ...)
  throttle = cast(int, ...)
  notify = cast(int, ...)
  soft_block = cast(int, ...)
  degrade = cast(int, ...)
  allow_overage = cast(int, ...)

