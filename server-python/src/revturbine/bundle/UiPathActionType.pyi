from __future__ import annotations

import flatbuffers
import numpy as np

import typing
from typing import cast

uoffset: typing.TypeAlias = flatbuffers.number_types.UOffsetTFlags.py_type

class UiPathActionType(object):
  unknown = cast(int, ...)
  open_checkout_modal = cast(int, ...)
  navigate_to_plans = cast(int, ...)
  open_upgrade_modal = cast(int, ...)
  open_placement = cast(int, ...)
  book_demo = cast(int, ...)
  open_feature_tour = cast(int, ...)
  extend_trial = cast(int, ...)
  switch_billing_period = cast(int, ...)
  custom_url = cast(int, ...)
  dismiss = cast(int, ...)
  contact_sales = cast(int, ...)
  complete_onboarding = cast(int, ...)
  invite_teammate = cast(int, ...)
  refer_friend = cast(int, ...)
  verify_work_email = cast(int, ...)
  update_payment_method = cast(int, ...)
  enable_auto_renewal = cast(int, ...)
  manage_subscription = cast(int, ...)

