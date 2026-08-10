from __future__ import annotations

import flatbuffers
import numpy as np

import typing

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class TokenValueEntry(object):
  @classmethod
  def SizeOf(cls) -> int: ...

  def Init(self, buf: bytes, pos: int) -> None: ...
  def Key(self) -> int: ...
  def Value(self) -> int: ...

def CreateTokenValueEntry(builder: flatbuffers.Builder, key: int, value: int) -> uoffset: ...

