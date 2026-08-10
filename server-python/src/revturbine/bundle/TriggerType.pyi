from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class TriggerType(object):
  unknown = cast(int, ...)
  surface_render = cast(int, ...)
  entitlement_gate = cast(int, ...)
  usage_threshold = cast(int, ...)
  credit_threshold = cast(int, ...)
  seat_threshold = cast(int, ...)
  trial_started = cast(int, ...)
  trial_progress = cast(int, ...)
  trial_ending = cast(int, ...)
  trial_ended = cast(int, ...)
  trial_converted = cast(int, ...)
  qualifier = cast(int, ...)

