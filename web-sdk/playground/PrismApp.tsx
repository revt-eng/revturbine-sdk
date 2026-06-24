import { useMemo, useState } from 'react';
import { RevTurbineProvider, createLocalRuntimeConfig } from '../index';
import { InMemoryStorage } from '../storage';
import { PRISM_CONFIG } from './config/prism-config';
import { DemoProvider, useDemo } from './state/DemoProvider';
import { StudioProvider } from './state/StudioProvider';
import { resolutionKey } from './state/demo-state';
import { toTrialStatus, toUserContext } from './state/to-user-context';
import { ImageStudio } from './stage/ImageStudio';
import { Nudges } from './stage/Nudges';
import { gatePlacementForHandle } from './state/active-nudges';
import { dispatchCta, type CtaPath, type DemoActions } from './state/cta-actions';
import { ContactModal, PlansModal } from './stage/Storefront';
import { AppBar } from './stage/AppBar';
import { AppSidebar } from './stage/AppSidebar';
import { DirectorPanel } from './stage/DirectorPanel';
import type { PlacementUiPath } from '../placements/types';

const ACTIVITY_LIMIT = 8;
const DIRECTOR_COLLAPSED_KEY = 'revturbine:prism:director-collapsed';

function loadDirectorCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DIRECTOR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The Prism playground (plan 83). Prism's own app chrome — app bar + sidebar +
 * stage — sits inside a single `RevTurbineProvider` that remounts on context
 * change so every placement re-resolves cleanly. The Director (the demo
 * sandbox) is a distinct, collapsible panel *outside* the provider; it mutates
 * demo state above the SDK boundary via {@link useDemo}.
 */
function PrismStage() {
  const { state, patch, patchCustom } = useDemo();
  const [activity, setActivity] = useState<string[]>([]);
  const [gatePlacementId, setGatePlacementId] = useState<string | null>(null);
  const [showPlans, setShowPlans] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [directorCollapsed, setDirectorCollapsed] = useState(loadDirectorCollapsed);
  const note = (label: string) => setActivity((prev) => [label, ...prev].slice(0, ACTIVITY_LIMIT));

  const toggleDirector = () =>
    setDirectorCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(DIRECTOR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* localStorage unavailable — non-fatal for a demo. */
      }
      return next;
    });

  // The in-demo effects a placement CTA can drive. Mutating demo state makes the
  // consequence visible: gates clear, the watermark drops, quota jumps, etc.
  const actions: DemoActions = {
    upgradeTo: (plan) => {
      setGatePlacementId(null);
      patch({ planHandle: plan });
    },
    topUpCredits: (amount) => patch({ creditBalance: Math.min(20, state.creditBalance + amount) }),
    switchBillingPeriod: (period) => patchCustom({ billing_period: period }),
    openPlans: () => setShowPlans(true),
    contactSales: () => {
      setShowPlans(false);
      setShowContact(true);
    },
    fixPayment: () => patchCustom({ billing_status: 'ok' }),
    note,
  };
  const handleCta = (cta: CtaPath) => dispatchCta(cta, actions);
  const handleSlotCta = (_label: string, uiPath: PlacementUiPath) =>
    handleCta({ type: String(uiPath.type), params: uiPath.params ?? {} });

  const options = useMemo(
    () =>
      createLocalRuntimeConfig({
        tenantId: 'prism',
        apiKey: 'local',
        endpoint: 'http://localhost',
        mode: 'react',
        // A fresh in-memory store per mount. The provider remounts on every
        // Director change (see remountKey), so each state re-resolves from
        // scratch — and the SDK's default localStorage store can't persist a
        // stale trialStatus that would override initialData.trialStatus on the
        // next mount (plan 82).
        persistentStorage: new InMemoryStorage(),
        user: toUserContext(PRISM_CONFIG, state),
        localRuntime: {
          exportedConfig: PRISM_CONFIG,
          initialData: { trialStatus: toTrialStatus(state) },
          resolvers: { getTrialStatus: () => toTrialStatus(state) },
        },
        uiPathResolvers: {
          open_checkout_modal: () => note('SDK · checkout'),
          navigate_to_plans: () => note('SDK · view plans'),
          contact_sales: () => note('SDK · contact sales'),
          switch_billing_period: () => note('SDK · switch to annual'),
        },
      }),
    [state],
  );

  // Remount the SDK subtree when any resolved-context dimension changes, so
  // slots re-resolve from scratch. StudioProvider sits above this boundary, so
  // the generated gallery survives the remount.
  const remountKey = resolutionKey(state);

  return (
    <div className={`prism${directorCollapsed ? ' prism--director-collapsed' : ''}`}>
      <div className="prism-app">
        <RevTurbineProvider key={remountKey} options={options}>
          <AppBar planHandle={state.planHandle} onSlotCta={handleSlotCta} />

          <div className="prism-app__body">
            <AppSidebar onSlotCta={handleSlotCta} />

            <main className="prism-app__main">
              <Nudges
                gatePlacementId={gatePlacementId}
                onCta={handleCta}
                onDismissGate={() => setGatePlacementId(null)}
              />

              <ImageStudio
                onStatus={note}
                onGate={(kind, handle) => {
                  note(`${kind === 'hard' ? 'Hard' : 'Soft'} gate · ${handle}`);
                  const pid = gatePlacementForHandle(handle);
                  if (pid) setGatePlacementId(pid);
                }}
              />
            </main>
          </div>
        </RevTurbineProvider>
      </div>

      <DirectorPanel
        note={note}
        activity={activity}
        collapsed={directorCollapsed}
        onToggle={toggleDirector}
        onResetGate={() => setGatePlacementId(null)}
      />

      {showPlans && (
        <PlansModal
          currentPlan={state.planHandle}
          onChoose={(plan) => {
            actions.upgradeTo(plan);
            note(`Chose ${plan}`);
            setShowPlans(false);
          }}
          onContactSales={() => {
            setShowPlans(false);
            setShowContact(true);
          }}
          onClose={() => setShowPlans(false)}
        />
      )}
      {showContact && <ContactModal onClose={() => setShowContact(false)} />}
    </div>
  );
}

/** Playground root: demo state + studio providers (above the SDK boundary). */
export function PrismApp() {
  return (
    <DemoProvider>
      <StudioProvider>
        <PrismStage />
      </StudioProvider>
    </DemoProvider>
  );
}
