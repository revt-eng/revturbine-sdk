import { useDemo } from '../state/DemoProvider';
import { isPrismPlanHandle } from '../state/demo-state';
import { JourneyManager } from './JourneyManager';

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
  /** Clear any open feature-gate modal (owned by the stage) on reset. */
  onResetGate: () => void;
}

export function DirectorPanel({ note, activity, collapsed, onToggle, onResetGate }: DirectorPanelProps) {
  const { state, patch, patchCustom, patchTrial, reset } = useDemo();

  return (
    <aside className={`prism-director${collapsed ? ' is-collapsed' : ''}`} aria-label="Director — demo controls">
      <div className="prism-director__head">
        <span className="prism-director__title">⚙ Director</span>
        <span className="prism-director__tag">sandbox</span>
        <button
          className="prism-director__toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand Director' : 'Collapse Director'}
        >
          {collapsed ? '‹' : '›'}
        </button>
      </div>

      {!collapsed && (
        <div className="prism-director__body">
          <JourneyManager note={note} />
          <button
            className="prism-btn prism-btn--small"
            onClick={() => {
              reset();
              onResetGate();
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
                if (isPrismPlanHandle(e.target.value)) patch({ planHandle: e.target.value });
              }}
            >
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </label>

          <label className="prism__field">
            <span>Generations used · {state.generationsUsed}</span>
            <input
              type="range"
              min={0}
              max={40}
              value={state.generationsUsed}
              onChange={(e) => patch({ generationsUsed: Number(e.target.value) })}
            />
          </label>

          <label className="prism__field">
            <span>Credit balance · {state.creditBalance}</span>
            <input
              type="range"
              min={0}
              max={20}
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

            <label className="prism__check">
              <input
                type="checkbox"
                checked={state.custom.has_purchased}
                onChange={(e) => patchCustom({ has_purchased: e.target.checked })}
              />
              <span>Has purchased</span>
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
          </div>

          <div className="prism__group">
            <h3 className="prism__group-title">Trial</h3>

            <label className="prism__check">
              <input
                type="checkbox"
                checked={state.trial.inTrial}
                onChange={(e) =>
                  patchTrial({
                    inTrial: e.target.checked,
                    trialType: e.target.checked ? (state.trial.trialType ?? 'free') : null,
                  })
                }
              />
              <span>In trial</span>
            </label>

            <label className="prism__field">
              <span>Trial type</span>
              <select
                value={state.trial.trialType ?? 'free'}
                disabled={!state.trial.inTrial}
                onChange={(e) => patchTrial({ trialType: e.target.value === 'reverse' ? 'reverse' : 'free' })}
              >
                <option value="free">Free trial</option>
                <option value="reverse">Reverse trial</option>
              </select>
            </label>

            <label className="prism__field">
              <span>Trial day · {state.trial.dayNumber}</span>
              <input
                type="range"
                min={0}
                max={30}
                value={state.trial.dayNumber}
                disabled={!state.trial.inTrial}
                onChange={(e) => patchTrial({ dayNumber: Number(e.target.value) })}
              />
            </label>

            <label className="prism__field">
              <span>Days remaining · {state.trial.daysRemaining}</span>
              <input
                type="range"
                min={0}
                max={30}
                value={state.trial.daysRemaining}
                disabled={!state.trial.inTrial}
                onChange={(e) => patchTrial({ daysRemaining: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="prism__activity">
            <h3>Activity</h3>
            {activity.length === 0 ? (
              <p className="prism__muted">Generate an image or click a placement…</p>
            ) : (
              <ul>
                {activity.map((entry, i) => (
                  <li key={`${entry}-${i}`}>{entry}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
