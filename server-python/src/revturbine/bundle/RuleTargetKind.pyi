from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class RuleTargetKind(object):
  plan = cast(int, ...)
  plan_variation = cast(int, ...)
  addon = cast(int, ...)
  addon_variation = cast(int, ...)

