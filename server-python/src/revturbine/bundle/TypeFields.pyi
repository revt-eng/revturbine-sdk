from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class TypeFields(object):
  NONE = cast(int, ...)
  FeatureFields = cast(int, ...)
  UsageLimitFields = cast(int, ...)
  CreditsFields = cast(int, ...)
  SeatsFields = cast(int, ...)
  TieredFields = cast(int, ...)

