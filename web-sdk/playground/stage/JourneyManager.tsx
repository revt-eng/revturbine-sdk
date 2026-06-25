import { useEffect, useState } from 'react';
import { useDemo } from '../state/DemoProvider';
import { useStudio } from '../state/StudioProvider';
import { resolutionKey } from '../state/demo-state';
import { JOURNEY_SETS, findJourney, type Journey } from '../state/journeys';

/** Opening journey — the demo always starts here (a brand-new free user). */
const DEFAULT_JOURNEY = 'baseline';

/**
 * Journey loader (plan 83) — load a saved journey snapshot into the User
 * Context, jumping the simulated user straight to a scripted monetization
 * moment. Selecting a journey is a full reset: it replaces the whole user
 * state AND clears the generated gallery, so each journey starts clean. Sets
 * are JSON files under `playground/journeys/`; the built-in set ships the
 * canonical demo scenarios. (In-app journey authoring/save is removed for now;
 * the underlying save helpers in `state/journeys.ts` are retained.)
 */
export function JourneyManager({
  note,
  onReset,
}: {
  note: (label: string) => void;
  /** Clear the stage's ephemeral state (gate + activity) — same as Reset. */
  onReset: () => void;
}) {
  const { state, setState } = useDemo();
  const { clear: clearGallery } = useStudio();
  const sets = JOURNEY_SETS;
  const [selected, setSelected] = useState<string>(DEFAULT_JOURNEY);

  const activeJourney: Journey | undefined = findJourney(selected, sets);

  function loadJourney(id: string) {
    const journey = findJourney(id, sets);
    if (!journey) return;
    // A journey change is a full reset: replace the user, clear the gallery +
    // rate-limit window (clearGallery) and the stage's ephemeral state (onReset).
    setState(journey.state);
    clearGallery();
    onReset();
    setSelected(journey.id);
    note(`Journey: ${journey.label}`);
  }

  // Open the demo on the default journey rather than whatever was last
  // persisted — but only reset if the persisted state actually differs.
  // A no-op setState here would change the SDK `options` identity WITHOUT
  // changing the provider remount key, re-initialising the SDK in place and
  // blanking the fixed slots (the usage meter / credit counter). Guarding on
  // resolutionKey avoids that churn when we're already on the default.
  useEffect(() => {
    const baseline = findJourney(DEFAULT_JOURNEY, sets);
    if (baseline && resolutionKey(state) !== resolutionKey(baseline.state)) {
      loadJourney(DEFAULT_JOURNEY);
    }
  }, []);

  return (
    <div className="prism__group">
      <h3 className="prism__group-title">Journeys</h3>

      <label className="prism__field">
        <span>Load journey</span>
        <select value={selected} onChange={(e) => loadJourney(e.target.value)}>
          {sets.map((set) => (
            <optgroup key={set.id} label={set.label}>
              {set.journeys.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {activeJourney && <p className="prism__muted">{activeJourney.shows}</p>}
    </div>
  );
}
