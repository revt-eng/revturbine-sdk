from __future__ import annotations

import flatbuffers
import numpy as np

import typing

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class SurfaceTemplateField(object):
  @classmethod
  def SizeOf(cls) -> int: ...

  def Init(self, buf: bytes, pos: int) -> None: ...
  def Name(self) -> int: ...
  def Type(self) -> int: ...
  def Required(self) -> bool: ...

def CreateSurfaceTemplateField(builder: flatbuffers.Builder, name: int, type: int, required: bool) -> uoffset: ...

