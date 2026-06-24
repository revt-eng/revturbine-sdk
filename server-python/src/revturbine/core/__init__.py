"""revturbine.core — pure-helper port of @revt-eng/core.

Each submodule mirrors a section of the canonical TypeScript core. The
parity test suite (plan 33 TASK-8/9/10) asserts behavioral equivalence
against shared fixtures; do not rely on visual inspection alone when
translating semantic edge cases (numeric coercion, slug rules, JSON
ordering).
"""
