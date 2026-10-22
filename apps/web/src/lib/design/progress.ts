import {
  type DesignFailureView,
  type DesignProgressView,
  STALL_AFTER_MS,
  type TaskDesignView,
} from '@nautelle/shared';

/** What a queued run says, build or turn alike. */
export const WAITING_FOR_SLOT = 'Waiting for a free runner slot…';

const stepPrefix = (progress: DesignProgressView): string =>
  progress.step === null ? '' : `Step ${progress.step}/2 · `;

const variantOf = (progress: DesignProgressView): string =>
  progress.variant === null
    ? 'a variant'
    : `variant ${progress.variant} of ${progress.variantCount}`;

/** #606: what a busy design with nothing running says. */
export const STARTING = 'Starting the next turn…';

/**
 * Whether a design run is under way: the status is busy, or — #840 — a
 * design turn is still queued or running, which the status may no longer
 * say while the turn finishes.
 */
export const isDesignBusy = (
  design: Pick<TaskDesignView, 'status' | 'activeTurnId'>,
): boolean =>
  design.status === 'generating' ||
  design.status === 'revising' ||
  design.activeTurnId !== null;

/**
 * #606: busy with neither a turn nor a build (D1's `null` progress) — the
 * gap between two variants of a batch, or a batch whose next turn never
 * started — or, #840, a turn with no progress reported. It shows as
 * starting, with Stop, never as the Generate panel.
 */
export const isStarting = (
  design: Pick<TaskDesignView, 'status' | 'progress' | 'activeTurnId'>,
): boolean => isDesignBusy(design) && design.progress === null;

/** D1: the stage line of the progress card. */
export function progressLabel(progress: DesignProgressView): string {
  if (progress.phase === 'queued') return WAITING_FOR_SLOT;
  switch (progress.stage) {
    case 'profile':
      return `${stepPrefix(progress)}Building the UI profile`;
    case 'draw':
      return `${stepPrefix(progress)}Drawing ${variantOf(progress)}`;
    case 'revise':
      return `${stepPrefix(progress)}Revising ${variantOf(progress)}`;
  }
}

/** The milliseconds since `since` (ISO), never negative. */
export const elapsedSince = (since: string, now: number): number =>
  Math.max(0, now - Date.parse(since));

/**
 * D4: when the run last printed something — the runner's stream mtime, else
 * when the newest live line arrived here, else when the job started.
 */
export function lastOutputOf(
  progress: Pick<DesignProgressView, 'startedAt'>,
  lastOutputAt: string | null,
  lastLineAt: number | null,
): number {
  if (lastOutputAt !== null) return Date.parse(lastOutputAt);
  if (lastLineAt !== null) return lastLineAt;
  return Date.parse(progress.startedAt);
}

/** D4: five minutes without output while running; a queued run never stalls. */
export function isStalled(
  progress: DesignProgressView,
  lastOutputAt: string | null,
  lastLineAt: number | null,
  now: number,
): boolean {
  if (progress.phase !== 'running') return false;
  return (
    now - lastOutputOf(progress, lastOutputAt, lastLineAt) >= STALL_AFTER_MS
  );
}

/** D6: what the person reads when a batch ended without a revision. */
export function failureSentence(failure: DesignFailureView): string {
  const what =
    failure.stage === 'profile'
      ? 'building the UI profile'
      : failure.variant === null
        ? 'drawing the mockup'
        : `${failure.stage === 'revise' ? 'revising' : 'drawing'} variant ${failure.variant}`;
  switch (failure.reason) {
    case 'timed_out':
      return `Timed out while ${what}.`;
    case 'stopped':
      return `Stopped while ${what}.`;
    case 'failed':
      return failure.message
        ? `Failed while ${what}: ${failure.message}`
        : `Failed while ${what}.`;
  }
}

/** m:ss, from 0:00; the card chip's clock. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
