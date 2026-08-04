from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class UsageAllocation(object):
  unknown = cast(int, ...)
  account_pool = cast(int, ...)
  per_instance = cast(int, ...)
  per_user = cast(int, ...)
  per_user_pooled = cast(int, ...)

