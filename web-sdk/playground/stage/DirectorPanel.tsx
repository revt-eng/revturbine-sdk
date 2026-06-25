import { useState } from 'react';
import { useDemo } from '../state/DemoProvider';
import { useStudio } from '../state/StudioProvider';
import { PRISM_CONFIG } from '../config/prism-config';
import { creditAllowanceFor, generationsLimitFor } from '../state/derived';
import { isPrismPlanHandle, TRIAL_DURATION_DAYS, trialDaysRemaining } from '../state/demo-state';
import { JourneyManager } from './JourneyManager';
import { PlacementsModal } from './PlacementsModal';

/**
 * The Director (plan 83) — the demo sandbox, deliberately styled as *tooling*,
 * distinct from Prism's app chrome, and collapsible so it gets out of the way.
 * It mutates demo state (above the SDK boundary) via {@link useDemo}; the app's
 * slots re-resolve when the provider remounts on a state change.
 */
export interface DirectorPanelProps {
  /** Append to the activity feed. */
  note: (label: string) => void;
  activity: string[];
  collapsed: boolean;
  onToggle: () => void;
  /**
   * Clear the stage's ephemeral state (any open gate modal + the activity
   * feed) on a reset or journey change — the studio gallery + rate-limit
   * window are cleared separately via the studio `clear()`.
   */
  onResetEphemeral: () => void;
}

export function DirectorPanel({ note, activity, collapsed, onToggle, onResetEphemeral }: DirectorPanelProps) {
  const { state, patch, patchCustom, patchTrial, reset } = useDemo();
  const { clear: clearGallery } = useStudio();
  const [showPlacements, setShowPlacements] = useState(false);

  // Scale the usage/credit sliders to the current plan's limits (capped for the
  // effectively-unlimited Enterprise tier), so you can reach a plan's warning
  // bands — e.g. 80% of Pro's 2,000 generations or 1,000 credits.
  const genLimit = generationsLimitFor(PRISM_CONFIG, state.planHandle);
  const genMax = Math.min(genLimit + Math.max(10, Math.round(genLimit * 0.1)), 2500);
  const creditMax = Math.min(creditAllowanceFor(PRISM_CONFIG, state.planHandle), 1000);

  return (
    <aside className={`prism-director${collapsed ? ' is-collapsed' : ''}`} aria-label="User context — demo controls">
      <div className="prism-director__head">
        <span className="prism-director__title">⚙ User Context</span>
        <span className="prism-director__tag">sandbox</span>
        <button
          className="prism-director__toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand user context' : 'Collapse user context'}
        >
          {collapsed ? '‹' : '›'}
        </button>
      </div>

      {!collapsed && (
        <div className="prism-director__body">
          <JourneyManager note={note} onReset={onResetEphemeral} />
          <button
            className="prism-btn prism-btn--small"
            onClick={() => {
              reset();
              clearGallery();
              onResetEphemeral();
              note('Reset to defaults');
            }}
          >
            Reset
          </button>

          <label className="prism__field">
            <span>Plan</span>
            <select
              value={state.planHandle}
              onChange={(e) => {
                if (!isPrismPlanHandle(e.target.value)) return;
                const plan = e.target.value;
                // Reset usage + credits to the new plan's baseline, so the old
                // values don't read as exhausted against a different allowance.
                patch({
                  planHandle: plan,
                  generationsUsed: 0,
                  creditBalance: creditAllowanceFor(PRISM_CONFIG, plan),
                });
              }}
            >
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </label>

          <label className="prism__field">
            <span>Billing period</span>
            <select
              value={state.custom.billing_period}
              onChange={(e) =>
                patchCustom({ billing_period: e.target.value === 'annual' ? 'annual' : 'monthly' })
              }
            >
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
          </label>

          <label className="prism__field">
            <span>Generations used · {state.generationsUsed}</span>
            <input
              type="range"
              min={0}
              max={genMax}
              value={state.generationsUsed}
              onChange={(e) => patch({ generationsUsed: Number(e.target.value) })}
            />
          </label>

          <label className="prism__field">
            <span>Credit balance · {state.creditBalance}</span>
            <input
              type="range"
              min={0}
              max={creditMax}
              value={state.creditBalance}
              onChange={(e) => patch({ creditBalance: Number(e.target.value) })}
            />
          </label>

          <label className="prism__field">
            <span>Seats used · {state.seatsUsed}</span>
            <input
              type="range"
              min={0}
              max={5}
              value={state.seatsUsed}
              onChange={(e) => patch({ seatsUsed: Number(e.target.value) })}
            />
          </label>

          <div className="prism__group">
            <h3 className="prism__group-title">Segmentation</h3>

            <label className="prism__field">
              <span>Email type</span>
              <select
                value={state.custom.email_type}
                onChange={(e) =>
                  patchCustom({ email_type: e.target.value === 'business' ? 'business' : 'personal' })
                }
              >
                <option value="personal">Personal</option>
                <option value="business">Business</option>
              </select>
            </label>

            {/* Persona dimension — buyer vs non-buyer is about who can upgrade
                on behalf of the account, so it sits next to Email type as a
                dropdown (the underlying trait is the boolean has_purchased). */}
            <label className="prism__field">
              <span>Buyer persona</span>
              <select
                value={state.custom.has_purchased ? 'buyer' : 'non_buyer'}
                onChange={(e) => patchCustom({ has_purchased: e.target.value === 'buyer' })}
              >
                <option value="buyer">Buyer (can upgrade)</option>
                <option value="non_buyer">Non-buyer</option>
              </select>
            </label>

            <label className="prism__field">
              <span>Engagement score · {state.custom.engagement_score}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={state.custom.engagement_score}
                onChange={(e) => patchCustom({ engagement_score: Number(e.target.value) })}
              />
            </label>

            <label className="prism__field">
              <span>Days since signup · {state.custom.days_since_signup}</span>
              <input
                type="range"
                min={0}
                max={60}
                value={state.custom.days_since_signup}
                onChange={(e) => patchCustom({ days_since_signup: Number(e.target.value) })}
              />
            </label>

            <label className="prism__field">
              <span>Days since active · {state.custom.days_since_active}</span>
              <input
                type="range"
                min={0}
                max={30}
                value={state.custom.days_since_active}
                onChange={(e) => patchCustom({ days_since_active: Number(e.target.value) })}
              />
            </label>

            <label className="prism__field">
              <span>Billing status</span>
              <select
                value={state.custom.billing_status}
                onChange={(e) =>
                  patchCustom({
                    billing_status:
                      e.target.value === 'failed' ? 'failed' : e.target.value === 'late' ? 'late' : 'ok',
                  })
                }
              >
                <option value="ok">OK</option>
                <option value="late">Late</option>
                <option value="failed">Failed</option>
              </select>
            </label>
          </div>

          <div className="prism__group">
            <h3 className="prism__group-title">Trial</h3>

            <label className="prism__field">
              <span>Trial type</span>
              <select
                value={state.trial.inTrial ? (state.trial.trialType ?? 'free') : 'none'}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'none') {
                    patchTrial({ inTrial: false, trialType: null });
                    return;
                  }
                  // Seed a fresh trial at day 0 with the full window so it reads
                  // "N more days" from signup, not "ends in 0 days".
                  const trialType = v === 'reverse' ? 'reverse' : 'free';
                  patchTrial({ inTrial: true, trialType, dayNumber: 0, daysRemaining: TRIAL_DURATION_DAYS });
                  // A reverse trial counts down off days_since_signup — reset it
                  // so the new trial starts fresh from signup.
                  if (trialType === 'reverse') patchCustom({ days_since_signup: 0 });
                }}
              >
                <option value="none">No trial</option>
                <option value="free">Free trial</option>
                <option value="reverse">Reverse trial</option>
              </select>
            </label>

            {/* Free trial: its own day axis (it's an opt-in trial, not tied to
                signup). Days remaining is derived (duration − day). A reverse
                trial instead counts down off "Days since signup" above, so its
                day slider would be a confusing duplicate — hidden here. */}
            {state.trial.trialType === 'reverse' ? (
              <p className="prism__hint">
                Reverse trial counts down from signup — use “Days since signup” above
                ({trialDaysRemaining(state.custom.days_since_signup)} of {TRIAL_DURATION_DAYS} days left).
              </p>
            ) : (
              <label className="prism__field">
                <span>
                  Days since trial start · {state.trial.dayNumber} ({trialDaysRemaining(state.trial.dayNumber)} left)
                </span>
                <input
                  type="range"
                  min={0}
                  max={TRIAL_DURATION_DAYS}
                  value={state.trial.dayNumber}
                  disabled={!state.trial.inTrial}
                  onChange={(e) => {
                    const dayNumber = Number(e.target.value);
                    patchTrial({ dayNumber, daysRemaining: trialDaysRemaining(dayNumber) });
                  }}
                />
              </label>
            )}
          </div>

          {/* Placements is a distinct RevTurbine concept from User Context — a
              peer section, equal prominence, its own divider + heading. */}
          <section className="prism-director__peer">
            <h3 className="prism-director__peer-title">Placements</h3>
            <button className="prism-link" onClick={() => setShowPlacements(true)}>
              View all placements
            </button>
          </section>

          <section className="prism-director__peer">
            <h3 className="prism-director__peer-title">Activity</h3>
            {activity.length === 0 ? (
              <p className="prism__muted">Generate an image or click a placement…</p>
            ) : (
              <ul className="prism__activity-list">
                {activity.map((entry, i) => (
                  <li key={`${entry}-${i}`}>{entry}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      {showPlacements && <PlacementsModal onClose={() => setShowPlacements(false)} />}
    </aside>
  );
}
