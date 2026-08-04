from __future__ import annotations

import flatbuffers
import numpy as np

import typing

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class Range(object):
  @classmethod
  def SizeOf(cls) -> int: ...

  def Init(self, buf: bytes, pos: int) -> None: ...
  def Start(self) -> int: ...
  def Count(self) -> int: ...

def CreateRange(builder: flatbuffers.Builder, start: int, count: int) -> uoffset: ...

