import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildLookupConfigKey,
  buildDefaultContentOverrides,
  buildExportedConfig,
  buildHarnessPlacementMap,
  createLocalRuntimeData,
  DEFAULT_ENTITLEMENT_RULES,
  DEFAULT_ENTITLEMENT_PAYLOADS,
  DEFAULT_ENTITLEMENTS,
  DEFAULT_PLANS,
  DEFAULT_SEGMENTS,
  DEFAULT_SLOT_TRIGGERS,
  DEFAULT_THEME,
  EDITABLE_CONTENT_FIELDS,
  ENTITLEMENT_TYPES,
  evaluateSegmentPredicates,
  HARNESS_SLOTS,
  loadConfigFromLocalStorage,
  loadExportedConfig,
  nextRuleId,
  resolveEntitlementPayloads,
  ruleLimit,
  saveConfigToLocalStorage,
  SEGMENT_PREDICATE_OPERATORS,
  SURFACE_TYPES,
  type EditableContentField,
  type HarnessEntitlement,
  type HarnessEntitlementPayload,
  type HarnessEntitlementRule,
  type HarnessPlan,
  type HarnessSegment,
  type HarnessSlotDescriptor,
  type HarnessSlotId,
  type HarnessTheme,
} from './scenarios';
import {
  createLocalRuntimeConfig,
  initRevTurbine,
  type PlacementOutput,
  type RevTurbineCustomerSdk,
} from '../index';
import { PlacementRenderer } from '../placements/PlacementRenderer';
import type { PlacementUiPath } from '../placements/types';

type PlacementState = Record<HarnessSlotId, PlacementOutput | null>;
type ActiveState = Record<HarnessSlotId, boolean>;
type TriggerState = Record<HarnessSlotId, Set<string>>;
type ContentOverrideState = Record<HarnessSlotId, Record<EditableContentField, string>>;
type SlotTab = 'triggers' | 'content' | 'meta';
type SlotTabState = Record<HarnessSlotId, SlotTab>;

function defaultActiveState(slots: HarnessSlotDescriptor[] = HARNESS_SLOTS): ActiveState {
  return slots.reduce<ActiveState>((acc, slot) => {
    acc[slot.id] = slot.surfaceType === 'banner' || slot.surfaceType === 'in_page' || slot.surfaceType === 'toast';
    return acc;
  }, {} as ActiveState);
}

function defaultTriggerState(slots: HarnessSlotDescriptor[] = HARNESS_SLOTS): TriggerState {
  return slots.reduce<TriggerState>((acc, slot) => {
    acc[slot.id] = new Set(DEFAULT_SLOT_TRIGGERS[slot.id] ?? []);
    return acc;
  }, {} as TriggerState);
}

function defaultSlotTabs(slots: HarnessSlotDescriptor[] = HARNESS_SLOTS): SlotTabState {
  return slots.reduce<SlotTabState>((acc, slot) => {
    acc[slot.id] = 'triggers';
    return acc;
  }, {} as SlotTabState);
}

function emptyPlacementState(slots: HarnessSlotDescriptor[] = HARNESS_SLOTS): PlacementState {
  return slots.reduce<PlacementState>((acc, slot) => {
    acc[slot.id] = null;
    return acc;
  }, {} as PlacementState);
}

function slotRequest(slot: HarnessSlotDescriptor, planHandle: string) {
  return {
    slotId: slot.id,
    surfaceType: slot.surfaceType,
    placementHandle: slot.placementHandle,
    planHandle,
  } as const;
}

function renderSurfaceLabel(surface: PlacementOutput['surface']['type']): string {
  if (surface === 'in_page') return 'In-page';
  if (surface === 'full_page') return 'Full page';
  return surface;
}

function hashString(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function stringifyTriggerState(triggerState: TriggerState): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(triggerState).map(([slotId, triggers]) => [slotId, [...triggers].sort()]),
  );
}

function buildDefaultTraitsInput(): string {
  return '{\n  "region": "us-east",\n  "workspace": "sdk-harness",\n  "role": "developer"\n}';
}

function recomputePayloads(
  planHandle: string,
  plans: HarnessPlan[],
  entitlements: HarnessEntitlement[],
  entitlementRules: HarnessEntitlementRule[],
): HarnessEntitlementPayload[] {
  const selectedPlan = plans.find((plan) => plan.unique_handle === planHandle) ?? plans[0];
  if (!selectedPlan) return [...DEFAULT_ENTITLEMENT_PAYLOADS];
  return resolveEntitlementPayloads(selectedPlan.id, entitlements, entitlementRules);
}

function cloneContentOverrides(nextSlots: HarnessSlotDescriptor[]): ContentOverrideState {
  return buildDefaultContentOverrides(nextSlots);
}

function mergeContentOverrides(
  defaults: ContentOverrideState,
  current: ContentOverrideState,
): ContentOverrideState {
  return Object.fromEntries(
    Object.entries(defaults).map(([slotId, fields]) => [slotId, { ...fields, ...(current[slotId] ?? {}) }]),
  ) as ContentOverrideState;
}

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

export function SdkLocalHarnessApp() {
  const [slots, setSlots] = useState<HarnessSlotDescriptor[]>(() => [...HARNESS_SLOTS]);
  const [plans, setPlans] = useState<HarnessPlan[]>(() => [...DEFAULT_PLANS]);
  const [entitlements, setEntitlements] = useState<HarnessEntitlement[]>(() => [...DEFAULT_ENTITLEMENTS]);
  const [entitlementRules, setEntitlementRules] = useState<HarnessEntitlementRule[]>(() => [...DEFAULT_ENTITLEMENT_RULES]);
  const [segments, setSegments] = useState<HarnessSegment[]>(() => [...DEFAULT_SEGMENTS]);
  const [activeSlots, setActiveSlots] = useState<ActiveState>(() => defaultActiveState(HARNESS_SLOTS));
  const [slotTriggers, setSlotTriggers] = useState<TriggerState>(() => defaultTriggerState(HARNESS_SLOTS));
  const [slotTabs, setSlotTabs] = useState<SlotTabState>(() => defaultSlotTabs(HARNESS_SLOTS));
  const [contentOverrides, setContentOverrides] = useState<ContentOverrideState>(() => cloneContentOverrides(HARNESS_SLOTS));
  const [theme, setTheme] = useState<HarnessTheme>({ ...DEFAULT_THEME });
  const [userId, setUserId] = useState('user_harness_01');
  const [userName, setUserName] = useState('Taylor Harness');
  const [planHandle, setPlanHandle] = useState('starter');
  const [usagePercent, setUsagePercent] = useState(72);
  const [entitlementAllowed, setEntitlementAllowed] = useState(false);
  const [traitsInput, setTraitsInput] = useState(buildDefaultTraitsInput());
  const [selectedSegmentId, setSelectedSegmentId] = useState('');
  const [rulesPlanFilter, setRulesPlanFilter] = useState('');
  const [eventName, setEventName] = useState('usage_limit_approaching');
  const [entitlementPayloads, setEntitlementPayloads] = useState<HarnessEntitlementPayload[]>(() =>
    recomputePayloads('starter', DEFAULT_PLANS, DEFAULT_ENTITLEMENTS, DEFAULT_ENTITLEMENT_RULES),
  );
  const [placementsBySlot, setPlacementsBySlot] = useState<PlacementState>(() => emptyPlacementState(HARNESS_SLOTS));
  const [busy, setBusy] = useState(false);
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const [configJson, setConfigJson] = useState('');
  const [configMessage, setConfigMessage] = useState('');
  const [newPlanName, setNewPlanName] = useState('');
  const [newEntitlementName, setNewEntitlementName] = useState('');
  const [newEntitlementType, setNewEntitlementType] = useState<(typeof ENTITLEMENT_TYPES)[number]>('feature');
  const [newSegmentName, setNewSegmentName] = useState('');

  const appendLog = useCallback((message: string) => {
    setActivityLog((prev) => [`${new Date().toLocaleTimeString()}: ${message}`, ...prev].slice(0, 16));
  }, []);

  const parsedTraits = useMemo(() => {
    try {
      const parsed = JSON.parse(traitsInput) as Record<string, unknown>;
      return { value: parsed, error: '' };
    } catch (error) {
      return {
        value: {} as Record<string, unknown>,
        error: error instanceof Error ? error.message : 'Invalid traits JSON',
      };
    }
  }, [traitsInput]);

  const matchedSegmentIds = useMemo(
    () => evaluateSegmentPredicates(segments, { planHandle, usagePercent, traits: parsedTraits.value }),
    [planHandle, parsedTraits.value, segments, usagePercent],
  );

  const effectiveSegmentIds = useMemo(() => {
    if (!selectedSegmentId) return matchedSegmentIds;
    return matchedSegmentIds.includes(selectedSegmentId)
      ? matchedSegmentIds
      : [...matchedSegmentIds, selectedSegmentId];
  }, [matchedSegmentIds, selectedSegmentId]);

  const placementCatalog = useMemo(() => {
    const basePlacements = buildHarnessPlacementMap(slots);
    return slots.reduce<Record<HarnessSlotId, PlacementOutput>>((acc, slot) => {
      const placement = basePlacements[slot.id];
      const overrides = contentOverrides[slot.id] ?? ({} as Record<EditableContentField, string>);
      const content = { ...placement.content } as Record<string, unknown>;
      for (const field of EDITABLE_CONTENT_FIELDS) {
        const value = overrides[field];
        if (typeof value === 'string' && value.trim().length > 0) {
          content[field] = value;
        }
      }
      acc[slot.id] = {
        ...placement,
        surface: {
          ...placement.surface,
          template: slot.template,
          slot_id: slot.id,
          type: slot.surfaceType,
        },
        content,
      };
      return acc;
    }, {} as Record<HarnessSlotId, PlacementOutput>);
  }, [contentOverrides, slots]);

  const runtimeData = useMemo(() => {
    const base = createLocalRuntimeData(
      activeSlots,
      userId,
      userName,
      planHandle,
      entitlementPayloads,
      slots,
      effectiveSegmentIds,
    );
    const placementsByLookupKey = { ...(base.placementsByLookupKey ?? {}) };
    for (const slot of slots) {
      const lookupKey = buildLookupConfigKey(slotRequest(slot, planHandle));
      placementsByLookupKey[lookupKey] = activeSlots[slot.id] ? placementCatalog[slot.id] : null;
    }
    return {
      ...base,
      placementsByLookupKey,
    };
  }, [activeSlots, effectiveSegmentIds, entitlementPayloads, placementCatalog, planHandle, slots, userId, userName]);

  const currentExportedConfig = useMemo(() => buildExportedConfig({
    plans,
    entitlements,
    entitlementRules,
    segments,
    activeSlots,
    slotTriggers,
    contentOverrides,
    theme,
    userId,
    userName,
    planHandle,
    usagePercent,
    entitlementAllowed,
    traitsInput,
    selectedSegmentId,
    rulesPlanFilter,
    eventName,
    entitlementPayloads,
    slots,
  }), [
    activeSlots,
    contentOverrides,
    entitlementAllowed,
    entitlementPayloads,
    entitlementRules,
    entitlements,
    eventName,
    planHandle,
    plans,
    rulesPlanFilter,
    segments,
    selectedSegmentId,
    slotTriggers,
    slots,
    theme,
    traitsInput,
    usagePercent,
    userId,
    userName,
  ]);

  const storageKey = useMemo(() => {
    const fingerprint = hashString(JSON.stringify({
      userId,
      userName,
      planHandle,
      usagePercent,
      activeSlots,
      slotTriggers: stringifyTriggerState(slotTriggers),
      contentOverrides,
      entitlementPayloads,
      traitsInput,
      slots,
    }));
    return `revturbine:sdk-local-harness:${fingerprint}`;
  }, [activeSlots, contentOverrides, entitlementPayloads, planHandle, slotTriggers, slots, traitsInput, usagePercent, userId, userName]);

  const sdk = useMemo<RevTurbineCustomerSdk>(() => initRevTurbine(createLocalRuntimeConfig({
    tenantId: 'tenant_local_harness',
    apiKey: 'local_only',
    endpoint: 'http://localhost:3000',
    mode: 'react',
    localRuntime: {
      storageKey,
      initialData: runtimeData,
    },
  })), [runtimeData, storageKey]);

  const applyLoadedConfig = useCallback((loaded: ReturnType<typeof loadExportedConfig>) => {
    setPlans(loaded.plans);
    setEntitlements(loaded.entitlements);
    setEntitlementRules(loaded.entitlementRules);
    setSegments(loaded.segments);
    setSlots(loaded.slots);
    setActiveSlots(loaded.activeSlots);
    setSlotTriggers(loaded.slotTriggers);
    setContentOverrides(mergeContentOverrides(cloneContentOverrides(loaded.slots), loaded.contentOverrides));
    setTheme(loaded.theme);
    setUserId(loaded.userId);
    setUserName(loaded.userName);
    setPlanHandle(loaded.planHandle);
    setUsagePercent(loaded.usagePercent);
    setEntitlementAllowed(loaded.entitlementAllowed);
    setTraitsInput(loaded.traitsInput);
    setSelectedSegmentId(loaded.selectedSegmentId);
    setRulesPlanFilter(loaded.rulesPlanFilter);
    setEventName(loaded.eventName);
    setEntitlementPayloads(loaded.entitlementPayloads);
    setSlotTabs(defaultSlotTabs(loaded.slots));
  }, []);

  useEffect(() => {
    const loaded = loadConfigFromLocalStorage();
    if (!loaded) {
      setConfigJson(JSON.stringify(currentExportedConfig, null, 2));
      return;
    }
    applyLoadedConfig(loaded);
    appendLog('Loaded saved harness config from local storage');
  }, [appendLog, applyLoadedConfig]);

  useEffect(() => {
    saveConfigToLocalStorage(currentExportedConfig);
    setConfigJson(JSON.stringify(currentExportedConfig, null, 2));
  }, [currentExportedConfig]);

  const resolvePlacements = useCallback(async () => {
    setBusy(true);
    try {
      const nextState = emptyPlacementState(slots);
      for (const slot of slots) {
        if (!activeSlots[slot.id]) {
          nextState[slot.id] = null;
          continue;
        }
        nextState[slot.id] = await sdk.getPlacement(slotRequest(slot, planHandle));
      }
      setPlacementsBySlot(nextState);
      appendLog(`Resolved ${Object.values(nextState).filter(Boolean).length} placement(s)`);
    } finally {
      setBusy(false);
    }
  }, [activeSlots, appendLog, planHandle, sdk, slots]);

  useEffect(() => {
    sdk.identify(userId, {
      plan: planHandle,
      traits: {
        user_name: userName,
        plan_name: planHandle,
        usage_percent: usagePercent,
        ...parsedTraits.value,
      },
    });
    void resolvePlacements();
  }, [parsedTraits.value, planHandle, resolvePlacements, sdk, usagePercent, userId, userName]);

  const filteredRules = useMemo(() => {
    if (!rulesPlanFilter) return entitlementRules;
    return entitlementRules.filter((rule) => rule.plan_ids.includes(rulesPlanFilter));
  }, [entitlementRules, rulesPlanFilter]);

  const activateAll = useCallback(() => {
    setActiveSlots(slots.reduce<ActiveState>((acc, slot) => {
      acc[slot.id] = true;
      return acc;
    }, {} as ActiveState));
    appendLog('Activated all slots');
  }, [appendLog, slots]);

  const clearAll = useCallback(() => {
    setActiveSlots(slots.reduce<ActiveState>((acc, slot) => {
      acc[slot.id] = false;
      return acc;
    }, {} as ActiveState));
    setPlacementsBySlot(emptyPlacementState(slots));
    appendLog('Cleared all slots');
  }, [appendLog, slots]);

  const updateRule = useCallback((ruleId: string, updater: (rule: HarnessEntitlementRule) => HarnessEntitlementRule) => {
    setEntitlementRules((prev) => prev.map((rule) => (rule.id === ruleId ? updater(rule) : rule)));
  }, []);

  const recomputeFromRules = useCallback((nextPlanHandle = planHandle) => {
    const nextPayloads = recomputePayloads(nextPlanHandle, plans, entitlements, entitlementRules);
    setEntitlementPayloads(nextPayloads);
    setEntitlementAllowed(nextPayloads.some((payload) => payload.allowed));
    appendLog(`Recomputed entitlement payloads for ${nextPlanHandle}`);
  }, [appendLog, entitlementRules, entitlements, planHandle, plans]);

  const emitTrigger = useCallback(() => {
    const nextActive = { ...activeSlots };
    let triggeredCount = 0;
    for (const slot of slots) {
      if (slotTriggers[slot.id]?.has(eventName)) {
        nextActive[slot.id] = true;
        triggeredCount += 1;
      }
    }
    setActiveSlots(nextActive);
    appendLog(`Emitted ${eventName} to ${triggeredCount} slot(s)`);
  }, [activeSlots, appendLog, eventName, slotTriggers, slots]);

  const handlePlacementCtaClick = useCallback(async (slot: HarnessSlotDescriptor, uiPath: PlacementUiPath) => {
    appendLog(`CTA clicked: ${slot.id} (${uiPath.type})`);
    setPlacementsBySlot((prev) => ({ ...prev, [slot.id]: null }));

    if (uiPath.type !== 'open_placement') {
      return;
    }

    const placementHandle = uiPath.placement_handle;
    if (!placementHandle) {
      appendLog(`CTA chain fallback: ${slot.id} missing placement_handle`);
      return;
    }

    const targetSlot = slots.find((candidate) => candidate.placementHandle === placementHandle);
    if (!targetSlot) {
      appendLog(`CTA chain fallback: ${slot.id} unresolved target ${placementHandle}`);
      return;
    }

    if (!activeSlots[targetSlot.id]) {
      appendLog(`CTA chain fallback: ${slot.id} target slot inactive (${targetSlot.id})`);
      return;
    }

    const chainedPlacement = await sdk.getPlacement(slotRequest(targetSlot, planHandle));
    setPlacementsBySlot((prev) => ({
      ...prev,
      [targetSlot.id]: chainedPlacement,
    }));
    appendLog(`CTA chain opened: ${slot.id} -> ${targetSlot.id}`);
  }, [activeSlots, appendLog, planHandle, sdk, slots]);

  const handleImportConfig = useCallback(() => {
    try {
      const parsed = JSON.parse(configJson);
      const loaded = loadExportedConfig(parsed);
      applyLoadedConfig(loaded);
      setConfigMessage('Imported RevTurbineConfig successfully');
      appendLog('Imported config JSON into harness');
    } catch (error) {
      setConfigMessage(error instanceof Error ? error.message : 'Failed to import config');
    }
  }, [appendLog, applyLoadedConfig, configJson]);

  const handleDownloadConfig = useCallback(() => {
    const content = JSON.stringify(currentExportedConfig, null, 2);
    downloadTextFile('revturbine-sdk-harness-export.json', content);
    appendLog('Downloaded RevTurbineConfig JSON');
  }, [appendLog, currentExportedConfig]);

  const handleCopyConfig = useCallback(async () => {
    const content = JSON.stringify(currentExportedConfig, null, 2);
    await navigator.clipboard.writeText(content);
    setConfigMessage('Copied RevTurbineConfig JSON to clipboard');
    appendLog('Copied RevTurbineConfig JSON');
  }, [appendLog, currentExportedConfig]);

  const matchedSegmentsSet = useMemo(() => new Set(matchedSegmentIds), [matchedSegmentIds]);
  const allTriggerValues = useMemo(
    () => Object.values(DEFAULT_SLOT_TRIGGERS).flat().filter((value, index, all) => all.indexOf(value) === index).sort(),
    [],
  );

  return (
    <div className="sdk-harness" data-testid="sdk-local-harness">
      <div className="sdk-harness__shell">
        <aside className="sdk-harness__side" data-testid="harness-side-panel">
          <div className="panel-section">
            <h2>Harness Controls</h2>
            <div className="control-grid">
              <label>
                User ID
                <input value={userId} onChange={(event) => setUserId(event.target.value)} />
              </label>
              <label>
                User Name
                <input value={userName} onChange={(event) => setUserName(event.target.value)} />
              </label>
              <label>
                Plan Handle
                <select
                  value={planHandle}
                  onChange={(event) => {
                    const nextPlanHandle = event.target.value;
                    setPlanHandle(nextPlanHandle);
                    recomputeFromRules(nextPlanHandle);
                  }}
                >
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.unique_handle}>{plan.unique_handle}</option>
                  ))}
                </select>
              </label>
              <label>
                Usage Percent
                <input
                  type="number"
                  min={0}
                  max={200}
                  value={usagePercent}
                  onChange={(event) => setUsagePercent(Math.max(0, Number(event.target.value) || 0))}
                />
              </label>
              <label>
                Traits JSON
                <textarea value={traitsInput} onChange={(event) => setTraitsInput(event.target.value)} />
              </label>
            </div>
            {parsedTraits.error ? <div className="side-log"><div>{parsedTraits.error}</div></div> : null}
            <div className="actions" style={{ marginTop: '0.65rem' }}>
              <button onClick={() => void resolvePlacements()} disabled={busy}>Resolve Now</button>
              <button onClick={activateAll}>Activate All</button>
              <button onClick={clearAll}>Clear All</button>
              <button onClick={emitTrigger}>Emit Trigger</button>
            </div>
            <div className="control-grid" style={{ marginTop: '0.65rem' }}>
              <label>
                Trigger Event
                <select value={eventName} onChange={(event) => setEventName(event.target.value)}>
                  {allTriggerValues.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="panel-section config-io-actions">
            <h2>Exported Config</h2>
            <div className="actions">
              <button onClick={handleDownloadConfig}>Download JSON</button>
              <button onClick={() => void handleCopyConfig()}>Copy JSON</button>
              <button onClick={handleImportConfig}>Import JSON</button>
              <button
                onClick={() => {
                  const loaded = loadConfigFromLocalStorage();
                  if (!loaded) {
                    setConfigMessage('No saved config found');
                    return;
                  }
                  applyLoadedConfig(loaded);
                  setConfigMessage('Loaded saved config from local storage');
                }}
              >
                Load Saved
              </button>
            </div>
            <div className="control-grid" style={{ marginTop: '0.55rem' }}>
              <label>
                ExportConfig JSON
                <textarea
                  data-testid="config-json-input"
                  value={configJson}
                  onChange={(event) => setConfigJson(event.target.value)}
                />
              </label>
            </div>
            {configMessage ? <div className="side-log"><div>{configMessage}</div></div> : null}
          </div>

          <div className="panel-section">
            <h2>Plans</h2>
            <div className="entity-list">
              {plans.map((plan) => (
                <span className="entity-chip" key={plan.id}>
                  {plan.name}
                  <small>{plan.unique_handle}</small>
                  <button
                    className="entity-chip__remove"
                    type="button"
                    onClick={() => {
                      const nextPlans = plans.filter((item) => item.id !== plan.id);
                      setPlans(nextPlans);
                      if (plan.unique_handle === planHandle && nextPlans[0]) {
                        setPlanHandle(nextPlans[0].unique_handle);
                        setTimeout(() => recomputeFromRules(nextPlans[0].unique_handle), 0);
                      }
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="entity-add-form">
              <input
                placeholder="New plan name"
                value={newPlanName}
                onChange={(event) => setNewPlanName(event.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const name = newPlanName.trim();
                  if (!name) return;
                  const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                  setPlans((prev) => [...prev, { id: `plan_${handle}`, unique_handle: handle, name }]);
                  setNewPlanName('');
                }}
              >
                Add Plan
              </button>
            </div>
          </div>

          <div className="panel-section">
            <h2>Entitlements</h2>
            <div className="entity-list">
              {entitlements.map((entitlement) => (
                <span className="entity-chip" key={entitlement.id}>
                  {entitlement.name}
                  <small>{entitlement.type}</small>
                  <button
                    className="entity-chip__remove"
                    type="button"
                    onClick={() => {
                      setEntitlements((prev) => prev.filter((item) => item.id !== entitlement.id));
                      setEntitlementRules((prev) => prev.filter((rule) => rule.entitlement_id !== entitlement.id));
                      setEntitlementPayloads((prev) => prev.filter((payload) => payload.handle !== entitlement.unique_handle));
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="entity-add-form">
              <input
                placeholder="New entitlement"
                value={newEntitlementName}
                onChange={(event) => setNewEntitlementName(event.target.value)}
              />
              <select value={newEntitlementType} onChange={(event) => setNewEntitlementType(event.target.value as (typeof ENTITLEMENT_TYPES)[number])}>
                {ENTITLEMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <button
                type="button"
                onClick={() => {
                  const name = newEntitlementName.trim();
                  if (!name) return;
                  const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                  setEntitlements((prev) => [...prev, {
                    id: `ent_${handle}`,
                    unique_handle: handle,
                    name,
                    type: newEntitlementType,
                    unit: newEntitlementType === 'seat' ? 'seats' : newEntitlementType === 'credits' ? 'credits' : undefined,
                  }]);
                  setNewEntitlementName('');
                }}
              >
                Add Entitlement
              </button>
            </div>
          </div>

          <div className="panel-section">
            <h2>Segments</h2>
            <div className="entity-list">
              {segments.map((segment) => (
                <span
                  className="entity-chip"
                  key={segment.id}
                  role="button"
                  data-active={selectedSegmentId === segment.id ? 'true' : 'false'}
                  data-matched={matchedSegmentsSet.has(segment.id) ? 'true' : 'false'}
                  onClick={() => setSelectedSegmentId((prev) => (prev === segment.id ? '' : segment.id))}
                >
                  {matchedSegmentsSet.has(segment.id) ? <span className="entity-chip__match-icon">•</span> : null}
                  {segment.name}
                  <small>{segment.handle}</small>
                  {segment.handle !== '_all' ? (
                    <button
                      className="entity-chip__remove"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSegments((prev) => prev.filter((item) => item.id !== segment.id));
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
            {selectedSegmentId ? (
              <div className="segment-predicates">
                <div className="segment-predicates__header">
                  <strong>
                    {segments.find((segment) => segment.id === selectedSegmentId)?.name ?? 'Selected segment'} predicates
                  </strong>
                  {matchedSegmentsSet.has(selectedSegmentId) ? <span className="segment-predicates__matched">matched</span> : null}
                  <button
                    className="segment-predicates__add"
                    type="button"
                    onClick={() => {
                      setSegments((prev) => prev.map((segment) => (
                        segment.id === selectedSegmentId
                          ? {
                              ...segment,
                              predicates: [...(segment.predicates ?? []), { field: 'plan_handle', operator: 'eq', value: 'starter' }],
                            }
                          : segment
                      )));
                    }}
                  >
                    Add Predicate
                  </button>
                </div>
                {(segments.find((segment) => segment.id === selectedSegmentId)?.predicates ?? []).length === 0 ? (
                  <div className="segment-predicates__empty">No predicates configured</div>
                ) : null}
                {(segments.find((segment) => segment.id === selectedSegmentId)?.predicates ?? []).map((predicate, predicateIndex) => (
                  <div className="segment-predicates__row" key={`${selectedSegmentId}-${predicateIndex}`}>
                    <input
                      className="segment-predicates__field"
                      value={predicate.field}
                      onChange={(event) => {
                        setSegments((prev) => prev.map((segment) => (
                          segment.id === selectedSegmentId
                            ? {
                                ...segment,
                                predicates: (segment.predicates ?? []).map((item, index) => index === predicateIndex ? { ...item, field: event.target.value } : item),
                              }
                            : segment
                        )));
                      }}
                    />
                    <select
                      className="segment-predicates__operator"
                      value={predicate.operator}
                      onChange={(event) => {
                        setSegments((prev) => prev.map((segment) => (
                          segment.id === selectedSegmentId
                            ? {
                                ...segment,
                                predicates: (segment.predicates ?? []).map((item, index) => index === predicateIndex ? { ...item, operator: event.target.value as (typeof SEGMENT_PREDICATE_OPERATORS)[number] } : item),
                              }
                            : segment
                        )));
                      }}
                    >
                      {SEGMENT_PREDICATE_OPERATORS.map((operator) => <option key={operator} value={operator}>{operator}</option>)}
                    </select>
                    <input
                      className="segment-predicates__value"
                      value={predicate.value}
                      onChange={(event) => {
                        setSegments((prev) => prev.map((segment) => (
                          segment.id === selectedSegmentId
                            ? {
                                ...segment,
                                predicates: (segment.predicates ?? []).map((item, index) => index === predicateIndex ? { ...item, value: event.target.value } : item),
                              }
                            : segment
                        )));
                      }}
                    />
                    <button
                      className="segment-predicates__remove"
                      type="button"
                      onClick={() => {
                        setSegments((prev) => prev.map((segment) => (
                          segment.id === selectedSegmentId
                            ? { ...segment, predicates: (segment.predicates ?? []).filter((_, index) => index !== predicateIndex) }
                            : segment
                        )));
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="entity-add-form">
              <input
                placeholder="New segment name"
                value={newSegmentName}
                onChange={(event) => setNewSegmentName(event.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const name = newSegmentName.trim();
                  if (!name) return;
                  const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                  setSegments((prev) => [...prev, { id: `seg_${handle}`, name, handle, predicates: [] }]);
                  setNewSegmentName('');
                }}
              >
                Add Segment
              </button>
            </div>
          </div>

          <div className="panel-section">
            <h2>Entitlement Rules</h2>
            <div className="rules-table__filter">
              <small>Plan Filter</small>
              <select value={rulesPlanFilter} onChange={(event) => setRulesPlanFilter(event.target.value)}>
                <option value="">All plans</option>
                {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
              </select>
            </div>
            <div className="rules-table">
              {filteredRules.map((rule) => {
                const entitlement = entitlements.find((item) => item.id === rule.entitlement_id);
                const limit = ruleLimit(rule);
                const percent = limit > 0 ? Math.min(999, Math.round((rule.current_usage / limit) * 100)) : 0;
                return (
                  <div className="rules-table__row" key={rule.id}>
                    <div className="rules-table__filters">
                      {rule.plan_ids.map((planId) => {
                        const plan = plans.find((item) => item.id === planId);
                        return <span className="rules-table__plan-badge" key={`${rule.id}-${planId}`}>{plan?.unique_handle ?? planId}</span>;
                      })}
                    </div>
                    <div className="rules-table__ent">
                      {entitlement?.name ?? rule.entitlement_id}
                      {rule.segment_ids && rule.segment_ids.length > 0 ? (
                        <span className="rules-table__seg-tag">seg: {rule.segment_ids.join(', ')}</span>
                      ) : null}
                    </div>
                    {rule.type_fields.kind === 'feature' ? (
                      <label className="rules-table__field">
                        <small>enabled</small>
                        <input
                          type="checkbox"
                          checked={rule.type_fields.enabled}
                          onChange={(event) => updateRule(rule.id, (current) => ({
                            ...current,
                            type_fields: { kind: 'feature', enabled: event.target.checked },
                          }))}
                        />
                      </label>
                    ) : rule.type_fields.kind === 'capability_tier' ? (
                      <label className="rules-table__field">
                        <small>tier</small>
                        <input
                          value={rule.type_fields.tier_name}
                          onChange={(event) => updateRule(rule.id, (current) => ({
                            ...current,
                            type_fields: { kind: 'capability_tier', tier_name: event.target.value },
                          }))}
                        />
                      </label>
                    ) : (
                      <>
                        <label className="rules-table__field">
                          <small>usage</small>
                          <input
                            type="number"
                            value={rule.current_usage}
                            onChange={(event) => updateRule(rule.id, (current) => ({
                              ...current,
                              current_usage: Math.max(0, Number(event.target.value) || 0),
                            }))}
                          />
                        </label>
                        <span className="rules-table__sep">/</span>
                        <label className="rules-table__field">
                          <small>limit</small>
                          <input
                            type="number"
                            value={limit}
                            onChange={(event) => {
                              const nextLimit = Math.max(1, Number(event.target.value) || 1);
                              updateRule(rule.id, (current) => {
                                if (current.type_fields.kind === 'usage_limit') {
                                  return { ...current, type_fields: { ...current.type_fields, limit_value: nextLimit } };
                                }
                                if (current.type_fields.kind === 'credits') {
                                  return { ...current, type_fields: { ...current.type_fields, allowance: nextLimit } };
                                }
                                if (current.type_fields.kind === 'seat') {
                                  return { ...current, type_fields: { ...current.type_fields, included_seats: nextLimit } };
                                }
                                return current;
                              });
                            }}
                          />
                        </label>
                        <div className="rules-table__pct" data-warn={percent >= 80 ? 'true' : 'false'}>{percent}%</div>
                      </>
                    )}
                    <button
                      className="entity-chip__remove"
                      type="button"
                      onClick={() => setEntitlementRules((prev) => prev.filter((item) => item.id !== rule.id))}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              {filteredRules.length === 0 ? <div className="rules-table__empty">No rules for the selected filter</div> : null}
            </div>
            <div className="entity-add-form">
              <button
                type="button"
                onClick={() => {
                  const selectedPlan = plans.find((plan) => plan.unique_handle === planHandle) ?? plans[0];
                  const selectedEntitlement = entitlements[0];
                  if (!selectedPlan || !selectedEntitlement) return;
                  setEntitlementRules((prev) => [...prev, {
                    id: nextRuleId(),
                    entitlement_id: selectedEntitlement.id,
                    plan_ids: [selectedPlan.id],
                    segment_ids: [],
                    type_fields: selectedEntitlement.type === 'feature'
                      ? { kind: 'feature', enabled: true }
                      : selectedEntitlement.type === 'capability_tier'
                        ? { kind: 'capability_tier', tier_name: 'pro' }
                        : selectedEntitlement.type === 'credits'
                          ? { kind: 'credits', allowance: 100, period: 'per_month', rollover: false, unit: selectedEntitlement.unit ?? 'credits' }
                          : selectedEntitlement.type === 'seat'
                            ? { kind: 'seat', included_seats: 5 }
                            : { kind: 'usage_limit', limit_value: 100, unit: selectedEntitlement.unit ?? 'units', period: 'per_month', enforcement: 'soft_block' },
                    current_usage: 0,
                  }]);
                }}
              >
                Add Rule
              </button>
              <button type="button" onClick={() => recomputeFromRules()}>Recompute Payloads</button>
            </div>
          </div>

          <div className="panel-section">
            <h2>Resolved Entitlements</h2>
            <div className="resolved-entitlements">
              {entitlementPayloads.map((payload) => (
                <div className="resolved-entitlements__row" data-allowed={payload.allowed ? 'true' : 'false'} key={payload.handle}>
                  <div className="resolved-entitlements__handle">{payload.handle}</div>
                  <div className="resolved-entitlements__status">{payload.status}</div>
                  {payload.reason ? <div className="resolved-entitlements__reason">{payload.reason}</div> : null}
                  <button
                    className="resolved-entitlements__gate-btn"
                    type="button"
                    onClick={() => {
                      setEntitlementPayloads((prev) => prev.map((item) => (
                        item.handle === payload.handle
                          ? {
                              ...item,
                              allowed: !item.allowed,
                              status: !item.allowed ? 'allowed' : 'denied',
                              reason: !item.allowed ? undefined : 'manually_gated',
                            }
                          : item
                      )));
                    }}
                  >
                    {payload.allowed ? 'Gate' : 'Allow'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="panel-section">
            <h2>Activity</h2>
            <div className="side-log" data-testid="harness-activity-log">
              {activityLog.length === 0 ? <div>No activity yet</div> : activityLog.map((line) => <div key={line}>{line}</div>)}
            </div>
          </div>
        </aside>

        <main className="sdk-harness__main" data-testid="harness-main-panel">
          <div className="main-header">
            <div>
              <h1>RevTurbine SDK Local-Mode Harness</h1>
              <p>Editable local-only harness for slots, entitlement state, user context, and RevTurbineConfig export/import.</p>
            </div>
            <div className="meta-pill">runtime_mode: local_only</div>
          </div>

          <section className="main-panel-slots">
            <h2>Matched Segments</h2>
            <div className="entity-list">
              {segments.filter((segment) => matchedSegmentsSet.has(segment.id)).map((segment) => (
                <span className="entity-chip" key={segment.id}>{segment.name}<small>{segment.handle}</small></span>
              ))}
              {matchedSegmentIds.length === 0 ? <span className="entity-chip">No automatic matches</span> : null}
            </div>
          </section>

          <section className="slot-grid">
            {slots.map((slot) => {
              const placement = placementsBySlot[slot.id];
              const tab = slotTabs[slot.id] ?? 'triggers';
              const slotContent = contentOverrides[slot.id];
              return (
                <article className="slot-card" key={slot.id}>
                  <header>
                    <h3>{slot.label}</h3>
                    <p>{slot.description}</p>
                  </header>
                  <div className="slot-card__body">
                    {placement ? (
                      <PlacementRenderer
                        placement={placement}
                        personalization={{ user_name: userName, plan_name: planHandle, ...parsedTraits.value }}
                        onImpression={() => appendLog(`Impression: ${slot.id}`)}
                        onDismiss={() => {
                          appendLog(`Dismissed: ${slot.id}`);
                          setPlacementsBySlot((prev) => ({ ...prev, [slot.id]: null }));
                        }}
                        onCtaClick={(uiPath) => {
                          void handlePlacementCtaClick(slot, uiPath);
                        }}
                      />
                    ) : (
                      <div className="empty-slot">Slot inactive or no placement resolved.</div>
                    )}
                    <div className="slot-card__config">
                      <div className="slot-card__config-tabs">
                        <button className="slot-card__tab" data-active={tab === 'triggers' ? 'true' : 'false'} type="button" onClick={() => setSlotTabs((prev) => ({ ...prev, [slot.id]: 'triggers' }))}>Triggers</button>
                        <button className="slot-card__tab" data-active={tab === 'content' ? 'true' : 'false'} type="button" onClick={() => setSlotTabs((prev) => ({ ...prev, [slot.id]: 'content' }))}>Content</button>
                        <button className="slot-card__tab" data-active={tab === 'meta' ? 'true' : 'false'} type="button" onClick={() => setSlotTabs((prev) => ({ ...prev, [slot.id]: 'meta' }))}>Meta</button>
                      </div>

                      {tab === 'triggers' ? (
                        <>
                          <div className="slot-card__config-label">Trigger Events</div>
                          <div className="slot-card__config-triggers">
                            {allTriggerValues.map((trigger) => {
                              const active = slotTriggers[slot.id]?.has(trigger) ?? false;
                              return (
                                <label className="slot-card__trigger-chip" data-active={active ? 'true' : 'false'} key={`${slot.id}-${trigger}`}>
                                  <input
                                    checked={active}
                                    type="checkbox"
                                    onChange={() => {
                                      setSlotTriggers((prev) => {
                                        const next = { ...prev };
                                        const nextSet = new Set(next[slot.id] ?? []);
                                        if (nextSet.has(trigger)) {
                                          nextSet.delete(trigger);
                                        } else {
                                          nextSet.add(trigger);
                                        }
                                        next[slot.id] = nextSet;
                                        return next;
                                      });
                                    }}
                                  />
                                  {trigger}
                                </label>
                              );
                            })}
                          </div>
                        </>
                      ) : null}

                      {tab === 'content' ? (
                        <div className="slot-card__content-editor">
                          {EDITABLE_CONTENT_FIELDS.map((field) => (
                            <label className="slot-card__content-field" key={`${slot.id}-${field}`}>
                              <span>{field}</span>
                              <input
                                value={slotContent?.[field] ?? ''}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setContentOverrides((prev) => ({
                                    ...prev,
                                    [slot.id]: {
                                      ...(prev[slot.id] ?? {} as Record<EditableContentField, string>),
                                      [field]: value,
                                    },
                                  }));
                                }}
                              />
                            </label>
                          ))}
                          <div className="slot-card__content-actions">
                            <button
                              type="button"
                              onClick={() => {
                                setContentOverrides((prev) => ({
                                  ...prev,
                                  [slot.id]: cloneContentOverrides(slots)[slot.id],
                                }));
                              }}
                            >
                              Reset Content
                            </button>
                            <button type="button" onClick={() => void resolvePlacements()}>Re-render</button>
                          </div>
                        </div>
                      ) : null}

                      {tab === 'meta' ? (
                        <div className="slot-card__content-editor">
                          <label className="slot-card__content-field">
                            <span>Label</span>
                            <input value={slot.label} onChange={(event) => setSlots((prev) => prev.map((item) => item.id === slot.id ? { ...item, label: event.target.value } : item))} />
                          </label>
                          <label className="slot-card__content-field">
                            <span>Description</span>
                            <input value={slot.description} onChange={(event) => setSlots((prev) => prev.map((item) => item.id === slot.id ? { ...item, description: event.target.value } : item))} />
                          </label>
                          <label className="slot-card__content-field">
                            <span>Placement Handle</span>
                            <input value={slot.placementHandle} onChange={(event) => setSlots((prev) => prev.map((item) => item.id === slot.id ? { ...item, placementHandle: event.target.value } : item))} />
                          </label>
                          <label className="slot-card__content-field">
                            <span>Template</span>
                            <input value={slot.template ?? ''} onChange={(event) => setSlots((prev) => prev.map((item) => item.id === slot.id ? { ...item, template: event.target.value } : item))} />
                          </label>
                          <label className="slot-card__content-field">
                            <span>Surface Type</span>
                            <select value={slot.surfaceType} onChange={(event) => setSlots((prev) => prev.map((item) => item.id === slot.id ? { ...item, surfaceType: event.target.value as PlacementOutput['surface']['type'] } : item))}>
                              {SURFACE_TYPES.map((surfaceType) => <option key={surfaceType} value={surfaceType}>{surfaceType}</option>)}
                            </select>
                          </label>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="slot-card__status">
                    <span>{renderSurfaceLabel(slot.surfaceType)} / {slot.id}</span>
                    <span className="slot-card__trigger-count">{slotTriggers[slot.id]?.size ?? 0} trigger(s)</span>
                  </div>
                </article>
              );
            })}
          </section>
        </main>
      </div>
    </div>
  );
}
