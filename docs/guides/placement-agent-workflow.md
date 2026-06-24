# Placement Agent Workflow

Use this guide when implementing or reviewing placement behavior in the customer SDK.

## Scope

Use this workflow for changes that affect:

- Placement selection and prioritization
- Placement rendering and slot mappings
- Lifecycle callbacks (`shown`, `dismiss`, `snooze`, `click`, `convert`)
- CTA behavior (`cta_path`, chained placements, click/convert semantics)
- Customer-facing SDK docs and cookbook examples

## Deterministic Workflow

1. Confirm contract scope first.
- If payload shape or response fields changed, update the authoritative schema in `revturbine-scaffold` first.
- Regenerate SDK artifacts before coding against generated types.

2. Define slot and surface behavior.
- Confirm slot id, surface type, and visibility constraints.
- Decide if behavior is slot-only, entitlement-gated, or CTA-chained.

3. Implement lifecycle callbacks explicitly.
- Ensure explicit code paths for `shown`, `dismiss`, `snooze`, `click`, `convert`.
- Keep interaction payloads contract-valid and correlated.

4. Validate CTA semantics.
- If `cta_path` changes, verify parsing, routing, and chained placement behavior.
- Ensure fallback behavior is explicit and does not silently drop user intent.

5. Verify runtime mode behavior.
- Confirm behavior remains explicit and testable in:
  - `revturbine_server`
  - `custom_endpoints`
  - `local_only` (where applicable)

6. Run targeted verification.
- Prefer narrow impacted tests first.
- Run build/docs checks for customer-facing changes.

## Do / Don't

Do:

- Use object-based placement request helpers and generated SDK types.
- Keep selection and lifecycle behavior deterministic.
- Update docs/examples whenever behavior changes.

Don't:

- Do not cast around missing/incorrect SDK route types.
- Do not bypass SDK interaction abstractions for lifecycle telemetry.
- Do not introduce placeholder-only behavior when a real path is expected.

## Acceptance Checklist

1. Contract alignment
- [ ] Schema updates completed (when needed)
- [ ] Artifacts regenerated

2. Runtime behavior
- [ ] Deterministic selection for equal-priority candidates
- [ ] Lifecycle callbacks wired for `shown`, `dismiss`, `snooze`, `click`, `convert`
- [ ] `cta_path` and chained behavior validated (when CTA logic changed)

3. Mode behavior
- [ ] Mock and real mode remain explicit and testable

4. Verification
- [ ] `npm --prefix web run build`
- [ ] `npm --prefix web run docs:sdk` (when SDK docs changed)
- [ ] Targeted SDK tests for touched surfaces

5. Documentation
- [ ] SDK README/guides updated for user-visible behavior changes

## Prompt Templates

### Add Slot Type

```md
Implement a new placement slot type end to end.

Scope:
- Update contract/source-of-truth files first when payload shape changes.
- Implement SDK render support and registration for the slot.
- Wire lifecycle callbacks and CTA behavior.
- Update cookbook/docs examples.

Requirements:
1. Define slot id/surface behavior and expected visibility constraints.
2. Ensure lifecycle callbacks are explicit: shown, dismiss, snooze, click, convert.
3. Validate cta_path semantics and chained placement behavior when CTA is present.
4. Keep runtime-mode behavior explicit (revturbine_server, custom_endpoints, local_only where applicable).

Verification:
- npm --prefix web run build
- npm --prefix web run docs:sdk (if SDK docs changed)
- targeted SDK tests for touched surfaces

Return:
- Changed files and slot ownership map
- Verification summary
- Residual risks/follow-ups
```

### Adjust Prioritization

```md
Update placement prioritization behavior while preserving deterministic selection.

Scope:
- Decision inputs and ranking/filtering logic related to placement selection.
- SDK expectations and docs/examples if visible ordering behavior changes.

Requirements:
1. Document current prioritization behavior and target change.
2. Apply minimal code changes to ranking/filtering path.
3. Preserve stable tie-breakers and deterministic output for equal scores.
4. Ensure lifecycle gating still enforces snooze/cooldown/caps.
5. Update tests/fixtures to prove deterministic ordering.

Verification:
- targeted decisioning/SDK tests for prioritization
- npm --prefix web run build (if customer-facing SDK/web surface changed)

Return:
- Before/after prioritization summary
- Evidence of deterministic behavior (tests/fixtures)
- Regression risks and follow-ups
```

### Add CTA Action

```md
Implement a new CTA action type for placements.

Scope:
- CTA action parsing, routing, and interaction/lifecycle hooks.
- Any contract/schema updates needed to represent the new CTA action.

Requirements:
1. Update authoritative contract definitions first when payload shape changes.
2. Implement CTA action handling with explicit validation and failure behavior.
3. Verify cta_path routing/chaining and fallback semantics.
4. Ensure click/convert telemetry remains contract-valid and correlated.
5. Update SDK docs/cookbook examples with one copy-paste snippet.

Verification:
- targeted tests for CTA action parsing and routing
- npm --prefix web run build
- npm --prefix web run docs:sdk (if docs changed)

Return:
- CTA contract/runtime changes
- Validation and test summary
- Remaining integration risks
```

### Debug Missing Render

```md
Debug a missing-placement render issue with a deterministic checklist.

Workflow:
1. Reproduce with explicit slot id, surface type, user context, and runtime mode.
2. Verify decision response eligibility and prioritization outcome.
3. Verify lifecycle suppression state (snooze, dismiss, cooldown, caps).
4. Verify renderer slot mapping/template resolution path.
5. Verify CTA/path behavior if placement depends on chained flow.
6. Apply minimal fix and add regression test.

Guardrails:
- Do not cast around SDK types.
- Keep mock and real mode behavior explicit.

Verification:
- targeted failing test reproduced then passing
- npm --prefix web run build
- additional narrow checks for touched files

Return:
- Root cause
- Minimal patch summary
- Verification output and residual risks
```