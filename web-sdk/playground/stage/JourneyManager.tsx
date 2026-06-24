import { useState } from 'react';
import { useDemo } from '../state/DemoProvider';
import {
  JOURNEY_SETS,
  findJourney,
  postJourneySet,
  toJourneyId,
  type Journey,
  type JourneySet,
} from '../state/journeys';

const BUILT_IN = 'built-in';
const NEW_SET = '__new__';

/**
 * Journey authoring (plan 83) — load a saved journey, or capture the current
 * Director state as a named journey and persist it into a set. Sets are JSON
 * files under `playground/journeys/`; saving POSTs to the dev-only write
 * middleware so the journey is committed to the codebase. The built-in set is
 * read-only; saves go to a user set (existing or new).
 */
export function JourneyManager({ note }: { note: (label: string) => void }) {
  const { state, setState } = useDemo();
  const [sets, setSets] = useState<JourneySet[]>(() => JOURNEY_SETS);
  const [selected, setSelected] = useState<string>('');

  const [saveLabel, setSaveLabel] = useState('');
  const userSets = sets.filter((set) => set.id !== BUILT_IN);
  const [targetSet, setTargetSet] = useState<string>(() => userSets[0]?.id ?? NEW_SET);
  const [newSetLabel, setNewSetLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const activeJourney: Journey | undefined = selected ? findJourney(selected, sets) : undefined;

  function loadJourney(id: string) {
    const journey = findJourney(id, sets);
    if (journey) {
      setState(journey.state);
      setSelected(journey.id);
      note(`Journey: ${journey.label}`);
    } else {
      setSelected('');
    }
  }

  async function save() {
    const label = saveLabel.trim();
    if (!label) {
      setStatus({ ok: false, text: 'Name the journey first.' });
      return;
    }
    const useNew = targetSet === NEW_SET;
    const setLabel = useNew ? newSetLabel.trim() || 'My journeys' : '';
    const setId = useNew ? toJourneyId(setLabel) : targetSet;
    if (!setId) {
      setStatus({ ok: false, text: 'Set name must contain a letter or number.' });
      return;
    }

    const journey: Journey = {
      id: toJourneyId(label),
      label,
      shows: `Saved journey: ${label}.`,
      state,
    };
    const existing = sets.find((set) => set.id === setId);
    const merged: JourneySet = {
      id: setId,
      label: existing?.label ?? setLabel,
      journeys: [...(existing?.journeys ?? []).filter((j) => j.id !== journey.id), journey],
    };

    setBusy(true);
    const result = await postJourneySet(merged);
    setBusy(false);
    if (!result.ok) {
      setStatus({ ok: false, text: `Save failed: ${result.error}` });
      return;
    }
    setSets((prev) => {
      const without = prev.filter((set) => set.id !== setId);
      return [...without, merged].sort((a, b) =>
        a.id === BUILT_IN ? -1 : b.id === BUILT_IN ? 1 : a.label.localeCompare(b.label),
      );
    });
    setSelected(journey.id);
    setTargetSet(setId);
    setNewSetLabel('');
    setStatus({ ok: true, text: `Saved to journeys/${setId}.json` });
    note(`Saved journey “${label}” → ${merged.label}`);
  }

  return (
    <div className="prism__group">
      <h3 className="prism__group-title">Journeys</h3>

      <label className="prism__field">
        <span>Load journey</span>
        <select value={selected} onChange={(e) => loadJourney(e.target.value)}>
          <option value="">Custom…</option>
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

      <div className="prism-director__save">
        <label className="prism__field">
          <span>Save current state as…</span>
          <input
            type="text"
            value={saveLabel}
            placeholder="Journey name"
            onChange={(e) => setSaveLabel(e.target.value)}
          />
        </label>

        <label className="prism__field">
          <span>Into set</span>
          <select value={targetSet} onChange={(e) => setTargetSet(e.target.value)}>
            {userSets.map((set) => (
              <option key={set.id} value={set.id}>
                {set.label}
              </option>
            ))}
            <option value={NEW_SET}>+ New set…</option>
          </select>
        </label>

        {targetSet === NEW_SET && (
          <label className="prism__field">
            <span>New set name</span>
            <input
              type="text"
              value={newSetLabel}
              placeholder="My journeys"
              onChange={(e) => setNewSetLabel(e.target.value)}
            />
          </label>
        )}

        <button className="prism-btn prism-btn--small" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save journey'}
        </button>
        {status && (
          <p className={status.ok ? 'prism__muted' : 'prism-director__error'}>{status.text}</p>
        )}
      </div>
    </div>
  );
}
