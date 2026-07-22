'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  RevTurbineContextMode,
  RevTurbinePlacementConfig,
  RevTurbinePlacementDecisionExplanation,
  RevTurbinePlacementDecisionOverrides,
  RevTurbineSurfaceSlotConfig,
} from '../customer-side';
import { useRevTurbine } from './useRevTurbine';
import { useRevTurbineTheme } from '../theme/ThemeContext';
import { UserProfile } from './UserProfile';

function groupRulesByPlanScope(
  rules: RevTurbinePlacementDecisionExplanation['entitlementRules'],
): Array<{ planScope: string; rules: RevTurbinePlacementDecisionExplanation['entitlementRules'] }> {
  const byScope = new Map<string, RevTurbinePlacementDecisionExplanation['entitlementRules']>();

  for (const rule of rules) {
    const key = rule.planScopes.length > 0 ? rule.planScopes.join(' | ') : 'all plans';
    const existing = byScope.get(key) ?? [];
    existing.push(rule);
    byScope.set(key, existing);
  }

  return Array.from(byScope.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([planScope, groupedRules]) => ({ planScope, rules: groupedRules }));
}

/**
 * Props for {@link PlacementDecisionInspector}.
 */
export interface PlacementDecisionInspectorProps {
  /**
   * Placement registration config used to resolve a placement ID.
   * @deprecated Use `surfaceSlot` instead.
   */
  placement?: RevTurbinePlacementConfig;
  /** Surface slot config used to resolve a placement ID. Preferred over `placement`. */
  surfaceSlot?: Pick<RevTurbineSurfaceSlotConfig, 'id' | 'name' | 'surfaceTemplateIds'>;
  /** Target user ID. Falls back to the SDK's current user context. */
  userId?: string;
  /** Context resolution mode. Defaults to `'auto'`. */
  contextMode?: RevTurbineContextMode;
  /** Optional segment/plan/usage overrides for debugging. */
  overrides?: RevTurbinePlacementDecisionOverrides;
  /** Optional traits merged into the decision request. */
  traits?: Record<string, string | number | boolean>;
  /** Optional decision cache TTL for the underlying decision call. */
  ttlMs?: number;
  /** Auto-load explanation on mount and dependency changes. Defaults to `true`. */
  autoLoad?: boolean;
  /** Optional class name for the root container. */
  className?: string;
  /** Optional inline styles for the root container. */
  style?: React.CSSProperties;
  /** Whether to render full JSON dumps for deep debugging. Defaults to `false`. */
  showRawJson?: boolean;
}

/**
 * Visual debug panel that explains why a placement decision was selected.
 *
 * Includes segment predicate evaluations, entitlement-rule matching,
 * final decision metadata, and policy/targeting snapshots.
 */
export function PlacementDecisionInspector({
  placement,
  surfaceSlot,
  userId,
  contextMode = 'auto',
  overrides,
  traits,
  ttlMs,
  autoLoad = true,
  className,
  style,
  showRawJson = false,
}: PlacementDecisionInspectorProps) {
  const { sdk, isReady } = useRevTurbine();
  // Every other placement component reads its colours from the theme; this one
  // hardcoded a light palette, so it rendered as a white card in dark hosts.
  const theme = useRevTurbineTheme();
  const c = theme.colors;
  // Semantic surfaces (a "matched"/"eligible" card) have no dedicated token, so
  // derive them by tinting the semantic colour into the card background — that
  // keeps the green reading in light themes and turns into a dark-green wash in
  // dark ones, without widening the public theme token set.
  const tint = (colour: string, pct: number) =>
    `color-mix(in srgb, ${colour} ${pct}%, ${c.background})`;
  const [placementId, setPlacementId] = useState('');
  const [explanation, setExplanation] = useState<RevTurbinePlacementDecisionExplanation | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const loadRequestSeqRef = useRef(0);
  const placementBindingRef = useRef('');

  const resolvedUserId = userId || (sdk ? sdk.getUserContext().user_id : '');
  const placementKey = useMemo(
    () => JSON.stringify(surfaceSlot ?? placement),
    [surfaceSlot, placement],
  );

  useEffect(() => {
    placementBindingRef.current = '';
    setPlacementId('');
    setExplanation(null);
    setError('');
  }, [placementKey]);

  const refresh = useCallback(async () => {
    if (!sdk || !isReady || !resolvedUserId) return;

    const requestSeq = loadRequestSeqRef.current + 1;
    loadRequestSeqRef.current = requestSeq;
    setIsLoading(true);
    setError('');

    try {
      let id = placementId;
      if (!id || placementBindingRef.current !== placementKey) {
        if (surfaceSlot) {
          id = await sdk.registerSurfaceSlot({
            id: surfaceSlot.id,
            name: surfaceSlot.name ?? surfaceSlot.id,
            surfaceTemplateIds: surfaceSlot.surfaceTemplateIds,
          });
        } else if (placement) {
          id = await sdk.registerPlacement(placement);
        } else {
          throw new Error('Either surfaceSlot or placement must be provided.');
        }
        if (requestSeq !== loadRequestSeqRef.current) return;
        placementBindingRef.current = placementKey;
        setPlacementId(id);
      }

      const nextExplanation = await sdk.explainPlacementDecision({
        placementId: id,
        userId: resolvedUserId,
        contextMode,
        overrides,
        traits,
        ttlMs,
      });

      if (requestSeq !== loadRequestSeqRef.current) return;
      setExplanation(nextExplanation);
    } catch {
      if (requestSeq === loadRequestSeqRef.current) {
        setError('Failed to load placement decision explanation.');
      }
    } finally {
      if (requestSeq === loadRequestSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, [
    sdk,
    isReady,
    resolvedUserId,
    placementId,
    placement,
    surfaceSlot,
    placementKey,
    contextMode,
    overrides,
    traits,
    ttlMs,
  ]);

  useEffect(() => {
    if (!autoLoad) return;
    void refresh();
  }, [autoLoad, refresh]);

  const matchedSegments = explanation?.segments.filter((segment) => segment.matched) ?? [];
  const unmatchedSegments = explanation?.segments.filter((segment) => !segment.matched) ?? [];
  const matchedEntitlementRules = explanation?.entitlementRules.filter((rule) => rule.matched) ?? [];
  const unmatchedEntitlementRules = explanation?.entitlementRules.filter((rule) => !rule.matched) ?? [];
  const eligiblePayloads = explanation?.eligiblePayloads ?? [];
  const selectedPayload = eligiblePayloads.find((payload) => payload.selected);
  const unselectedPayloads = eligiblePayloads.filter((payload) => !payload.selected);
  const matchedEntitlementRulesByPlan = groupRulesByPlanScope(matchedEntitlementRules);
  const unmatchedEntitlementRulesByPlan = groupRulesByPlanScope(unmatchedEntitlementRules);

  return (
    <section
      className={className}
      style={{
        border: `1px solid ${c.surfaceBorder}`,
        borderRadius: 10,
        padding: 14,
        background: c.background,
        fontFamily: theme.typography.fontFamily,
        color: c.text,
        ...style,
      }}
      data-rt-inspector="placement-decision"
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>Placement Decision Inspector</h3>
          <div style={{ fontSize: 12, color: c.textMuted, marginTop: 2 }}>
            {surfaceSlot ? `Slot: ${surfaceSlot.id}` : placement ? `Placement: ${placement.name}` : '(no target)'} | User: {resolvedUserId || '(missing)'}
          </div>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={isLoading || !resolvedUserId}>
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>

      {!resolvedUserId && (
        <p style={{ marginTop: 12, color: c.warning }}>
          No userId is available. Provide `userId` or set `user.id` in RevTurbineProvider options.
        </p>
      )}

      {error && <p style={{ marginTop: 12, color: c.danger }}>{error}</p>}
      {!explanation && !error && resolvedUserId && (
        <p style={{ marginTop: 12, color: c.textMuted }}>{isLoading ? 'Loading explanation...' : 'No explanation loaded yet.'}</p>
      )}

      {explanation && (
        <>
          <section style={{ marginTop: 14 }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Decision Summary</h4>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <div>visible: <strong>{String(explanation.decision.visible)}</strong></div>
              <div>source: <strong>{explanation.decision.decisionSource}</strong></div>
              <div>placementId: <code>{explanation.decision.placementId}</code></div>
              <div>ruleId: <code>{explanation.placementRules.ruleId ?? 'n/a'}</code></div>
              <div>decisionId: <code>{explanation.placementRules.decisionId ?? 'n/a'}</code></div>
              <div>suppression: <code>{explanation.placementRules.suppressionReason ?? 'none'}</code></div>
              <div>
                reasonCodes: {explanation.placementRules.reasonCodes.length > 0
                  ? explanation.placementRules.reasonCodes.join(', ')
                  : 'none'}
              </div>
            </div>
          </section>

          <section style={{ marginTop: 14 }}>
            <UserProfile targeting={explanation.targeting} title="User Context" />
          </section>

          <section style={{ marginTop: 14 }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Segments</h4>
            <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 6 }}>
              matched IDs: {explanation.targeting.segmentIds.length > 0
                ? explanation.targeting.segmentIds.join(', ')
                : 'none'}
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {matchedSegments.map((segment) => (
                <div
                  key={segment.segmentId}
                  style={{
                    border: `1px solid ${c.surfaceBorder}`,
                    borderRadius: 8,
                    padding: 8,
                    background: tint(c.success, 8),
                  }}
                >
                  <div style={{ fontSize: 13 }}>
                    <strong>{segment.segmentName ?? segment.segmentId}</strong> ({segment.segmentId})
                    {' '}→ matched
                  </div>
                  {segment.predicates.length > 0 && (
                    <ul style={{ margin: '6px 0 0 18px', fontSize: 12 }}>
                      {segment.predicates.map((predicate, index) => (
                        <li key={`${segment.segmentId}-${predicate.field}-${index}`}>
                          {predicate.field} {predicate.operator} {JSON.stringify(predicate.expected)}
                          {' '}| actual: {JSON.stringify(predicate.actual)}
                          {' '}| {predicate.matched ? 'pass' : 'fail'}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}

              {unmatchedSegments.length > 0 && (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                    Unmatched segments ({unmatchedSegments.length})
                  </summary>
                  <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                    {unmatchedSegments.map((segment) => (
                      <div
                        key={segment.segmentId}
                        style={{
                          border: `1px solid ${c.surfaceBorder}`,
                          borderRadius: 8,
                          padding: 8,
                          background: c.surface,
                        }}
                      >
                        <div style={{ fontSize: 13 }}>
                          <strong>{segment.segmentName ?? segment.segmentId}</strong> ({segment.segmentId})
                          {' '}→ not matched
                        </div>
                        {segment.predicates.length > 0 && (
                          <ul style={{ margin: '6px 0 0 18px', fontSize: 12 }}>
                            {segment.predicates.map((predicate, index) => (
                              <li key={`${segment.segmentId}-${predicate.field}-${index}`}>
                                {predicate.field} {predicate.operator} {JSON.stringify(predicate.expected)}
                                {' '}| actual: {JSON.stringify(predicate.actual)}
                                {' '}| {predicate.matched ? 'pass' : 'fail'}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </section>

          <section style={{ marginTop: 14 }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Entitlement Rules</h4>
            {explanation.entitlementRules.length === 0 ? (
              <div style={{ fontSize: 13, color: c.textMuted }}>No entitlement rules found in exported config.</div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {matchedEntitlementRulesByPlan.map((group) => (
                  <section key={`matched-${group.planScope}`} style={{ border: `1px solid ${c.surfaceBorder}`, borderRadius: 8, padding: 8 }}>
                    <div style={{ fontSize: 12, color: c.textSecondary, marginBottom: 6 }}>
                      <strong>Plan scope:</strong> {group.planScope}
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {group.rules.map((rule) => (
                        <div
                          key={rule.ruleId}
                          style={{
                            border: `1px solid ${tint(c.success, 35)}`,
                            borderRadius: 8,
                            padding: 8,
                            background: tint(c.success, 8),
                          }}
                        >
                          <div style={{ fontSize: 13 }}>
                            <strong>{rule.entitlementHandle ?? rule.entitlementId ?? rule.ruleId}</strong>
                            {rule.kind ? <span style={{ color: c.textMuted }}>{` (${rule.kind})`}</span> : ''}
                            {' '}→{' '}
                            <span style={{ color: rule.outcome === 'denied' ? c.danger : c.success }}>
                              {rule.outcomeDescription ?? rule.outcome}
                            </span>
                          </div>
                          {rule.reason && (
                            <div style={{ fontSize: 12, color: c.textSecondary, marginTop: 2 }}>
                              reason: {rule.reason}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                ))}

                {unmatchedEntitlementRules.length > 0 && (
                  <details>
                    <summary style={{ cursor: 'pointer', fontSize: 13, color: c.textMuted }}>
                      {unmatchedEntitlementRules.length} rule{unmatchedEntitlementRules.length === 1 ? '' : 's'} for other plans
                    </summary>
                    <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                      {unmatchedEntitlementRulesByPlan.map((group) => (
                        <section key={`unmatched-${group.planScope}`} style={{ border: `1px solid ${c.surfaceBorder}`, borderRadius: 8, padding: 8 }}>
                          <div style={{ fontSize: 12, color: c.textSecondary, marginBottom: 4 }}>
                            <strong>Plan scope:</strong> {group.planScope}
                          </div>
                          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: c.textMuted }}>
                            {group.rules.map((rule) => (
                              <li key={rule.ruleId}>
                                {rule.entitlementHandle ?? rule.entitlementId ?? rule.ruleId}
                                {rule.kind ? ` (${rule.kind})` : ''}
                                {' '}— {!rule.matchesPlan ? 'plan mismatch' : !rule.matchesSegment ? 'segment mismatch' : 'skipped'}
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </section>

          <section style={{ marginTop: 14 }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Other Rule Signals</h4>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <div>category: {explanation.placementRules.category ?? 'n/a'}</div>
              <div>cap policies: {explanation.placementRules.capPolicies.length}</div>
            </div>
            {explanation.placementRules.capPolicies.length > 0 && (
              <ul style={{ margin: '6px 0 0 18px', fontSize: 12 }}>
                {explanation.placementRules.capPolicies.map((policy, index) => (
                  <li key={`${policy.period}-${policy.count}-${index}`}>
                    max_per_period: {policy.count} / {policy.period}
                    {typeof policy.cooldownMs === 'number' ? ` | cooldownMs: ${policy.cooldownMs}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={{ marginTop: 14 }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>Eligible Placement Payloads</h4>
            {eligiblePayloads.length === 0 ? (
              <div style={{ fontSize: 13, color: c.textMuted }}>
                No payload records found for this placement in exported config.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 8 }}>
                  selected payload: {selectedPayload ? selectedPayload.payloadId : 'none'}
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {selectedPayload && (
                    <div
                      key={selectedPayload.payloadId}
                      style={{
                        border: `2px solid ${c.success}`,
                        borderRadius: 8,
                        padding: 8,
                        background: tint(c.success, 16),
                      }}
                    >
                      <div style={{ fontSize: 13 }}>
                        <strong>{selectedPayload.payloadId}</strong>
                        {' '}→ {selectedPayload.eligible ? 'eligible' : 'not eligible'} (selected)
                      </div>
                      <div style={{ fontSize: 12, color: c.textSecondary, marginTop: 4 }}>
                        status: {selectedPayload.status} |
                        plan scopes: {selectedPayload.planScopes.length > 0 ? selectedPayload.planScopes.join(', ') : 'all plans'} |
                        segment chips: {selectedPayload.segmentChips.length > 0 ? selectedPayload.segmentChips.join(', ') : 'none'} |
                        templates: {selectedPayload.surfaceTemplateIds.length > 0 ? selectedPayload.surfaceTemplateIds.join(', ') : 'none'}
                      </div>
                      <div style={{ fontSize: 12, color: c.textMuted, marginTop: 4 }}>
                        gate checks → planMatch: {String(selectedPayload.matchesPlan)} | segmentMatch: {String(selectedPayload.matchesSegment)}
                      </div>
                    </div>
                  )}

                  {unselectedPayloads.length > 0 && (
                    <details>
                      <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                        Unselected payloads ({unselectedPayloads.length})
                      </summary>
                      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                        {unselectedPayloads.map((payload) => (
                          <div
                            key={payload.payloadId}
                            style={{
                              border: `1px solid ${c.surfaceBorder}`,
                              borderRadius: 8,
                              padding: 8,
                              background: payload.eligible ? tint(c.success, 8) : c.surface,
                            }}
                          >
                            <div style={{ fontSize: 13 }}>
                              <strong>{payload.payloadId}</strong>
                              {' '}→ {payload.eligible ? 'eligible' : 'not eligible'}
                            </div>
                            <div style={{ fontSize: 12, color: c.textSecondary, marginTop: 4 }}>
                              status: {payload.status} |
                              plan scopes: {payload.planScopes.length > 0 ? payload.planScopes.join(', ') : 'all plans'} |
                              segment chips: {payload.segmentChips.length > 0 ? payload.segmentChips.join(', ') : 'none'} |
                              templates: {payload.surfaceTemplateIds.length > 0 ? payload.surfaceTemplateIds.join(', ') : 'none'}
                            </div>
                            <div style={{ fontSize: 12, color: c.textMuted, marginTop: 4 }}>
                              gate checks → planMatch: {String(payload.matchesPlan)} | segmentMatch: {String(payload.matchesSegment)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </>
            )}
          </section>

          {showRawJson && (
            <section style={{ marginTop: 14 }}>
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>Raw Explanation JSON</summary>
                <pre
                  style={{
                    marginTop: 8,
                    background: c.cliBackground,
                    color: c.cliText,
                    borderRadius: 8,
                    padding: 10,
                    overflowX: 'auto',
                    fontSize: 12,
                  }}
                >
                  {JSON.stringify(explanation, null, 2)}
                </pre>
              </details>
            </section>
          )}
        </>
      )}
    </section>
  );
}
