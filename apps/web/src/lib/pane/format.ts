import type { LiveErrorCode } from '@agentdock/shared';

const ERROR_SENTENCE: Partial<Record<LiveErrorCode, string>> = {
  forbidden: 'You are not a member of this project, so you cannot watch it.',
  not_found: 'This slot does not belong to this project.',
  too_many_viewers: 'Too many people are watching this worker right now.',
};

/** A sentence for a refused pane subscription. */
export function describePaneError(code: LiveErrorCode): string {
  return ERROR_SENTENCE[code] ?? 'The live pane could not be opened.';
}

export type PaneConnection = 'connected' | 'reconnecting' | 'ended';

export const PANE_CONNECTION_LABEL: Record<PaneConnection, string> = {
  connected: 'Live',
  reconnecting: 'Reconnecting',
  ended: 'Session ended',
};
