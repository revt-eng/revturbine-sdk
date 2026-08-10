from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from revturbine.bundle.PredicateOp import PredicateOp

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class SegmentPredicate(object):
  @classmethod
  def SizeOf(cls) -> int: ...

  def Init(self, buf: bytes, pos: int) -> None: ...
  def FieldIdx(self) -> int: ...
  def Op(self) -> typing.Literal[PredicateOp.unknown, PredicateOp.eq, PredicateOp.neq, PredicateOp.gt, PredicateOp.lt, PredicateOp.gte, PredicateOp.lte, PredicateOp.contains, PredicateOp.in_]: ...
  def Value(self) -> int: ...

def CreateSegmentPredicate(builder: flatbuffers.Builder, fieldIdx: int, op: typing.Literal[PredicateOp.unknown, PredicateOp.eq, PredicateOp.neq, PredicateOp.gt, PredicateOp.lt, PredicateOp.gte, PredicateOp.lte, PredicateOp.contains, PredicateOp.in_], value: int) -> uoffset: ...

