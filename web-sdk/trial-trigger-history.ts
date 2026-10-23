import { deriveTrialTriggerStage } from '@revt-eng/core';
import type { UserTrialStatus } from '@revt-eng/schema';

type Stage = ReturnType<typeof deriveTrialTriggerStage>;
type FiredStage = Exclude<Stage, 'none'>;
interface Episode {
  instanceId?: string;
  startedAt?: string;
  stages: FiredStage[];
  lastStage: Stage;
  ended: boolean;
}

function isStage(value: unknown): value is FiredStage { // sdk-ok: boundary-parse — validate an app-writable persisted stage
  return value === 'midpoint' || value === 'expiring' || value === 'expired';
}

/** Internal, user-scoped history; persisted only with local-runtime state. */
export class TrialTriggerHistory {
  private episodes: Episode[] = [];
  private current = -1;

  reset(): void {
    this.episodes = [];
    this.current = -1;
  }

  /** Return a stage once per episode, preserving identity across sparse sources. */
  observe(status: UserTrialStatus, expiringDays: number): FiredStage | undefined {
    const instanceId = status.instance_id;
    const startedAt = status.started_at;
    const active = this.episodes[this.current];
    let index = -1;
    if (instanceId) {
      index = this.episodes.findIndex((episode) => episode.instanceId === instanceId);
      if (index < 0 && active && !active.instanceId && !active.ended
        && (!startedAt || !active.startedAt || startedAt === active.startedAt)) index = this.current;
    } else if (startedAt) {
      index = this.episodes.findIndex((episode) => episode.startedAt === startedAt);
      if (index < 0 && active && !active.startedAt && !active.ended) index = this.current;
    } else if (active && !(active.ended && status.in_trial)) {
      index = this.current;
    }
    if (index < 0) {
      if (!status.in_trial && !active) return undefined;
      index = this.episodes.length;
      this.episodes.push({ stages: [], lastStage: 'none', ended: false });
    }
    this.current = index;
    const episode = this.episodes[index];
    if (!episode) return undefined;
    if (instanceId) episode.instanceId = instanceId;
    if (startedAt) episode.startedAt = startedAt;
    // A temporarily sparse/absent source isn't proof that a new trial began.
    // Legacy contexts without identity begin a new episode only after an
    // explicit terminal state followed by an active trial, or a user reset.
    episode.ended ||= status.state === 'expired' || status.state === 'converted'
      || (!status.in_trial && status.days_remaining === 0);
    const stage = deriveTrialTriggerStage(status, episode.lastStage, expiringDays);
    if (stage === 'none') return undefined;
    episode.lastStage = stage;
    if (episode.stages.includes(stage)) return undefined;
    episode.stages.push(stage);
    return stage;
  }

  snapshot(): { episodes: Episode[]; current: number } {
    return { episodes: this.episodes.map((episode) => ({ ...episode, stages: [...episode.stages] })), current: this.current };
  }

  /** Ignore malformed app-writable persisted history instead of breaking init. */
  restore(value: unknown): void { // sdk-ok: boundary-parse — validate app-writable storage before restoring internal history
    if (!value || typeof value !== 'object' || !('episodes' in value) || !Array.isArray(value.episodes)
      || !('current' in value) || typeof value.current !== 'number' || !Number.isInteger(value.current)) return;
    const episodes: Episode[] = [];
    const entries: unknown[] = value.episodes; // sdk-ok: boundary-parse — each persisted episode is validated below
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object' || !('stages' in raw) || !Array.isArray(raw.stages)
        || !raw.stages.every(isStage) || !('lastStage' in raw)
        || !(raw.lastStage === 'none' || isStage(raw.lastStage))) return;
      episodes.push({
        stages: raw.stages.filter(isStage), lastStage: raw.lastStage,
        ended: 'ended' in raw && raw.ended === true,
        ...('instanceId' in raw && typeof raw.instanceId === 'string' ? { instanceId: raw.instanceId } : {}),
        ...('startedAt' in raw && typeof raw.startedAt === 'string' ? { startedAt: raw.startedAt } : {}),
      });
    }
    if (value.current < -1 || value.current >= episodes.length) return;
    this.episodes = episodes;
    this.current = value.current;
  }
}
