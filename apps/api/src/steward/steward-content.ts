import { isStewardEventType } from '@nautelle/shared';
import type { RunnerEvent } from '@nautelle/shared/protocol';

/**
 * DA-12, D12: no pane text ever reaches `events.data` — the tail is removed
 * from every `steward.*` event in place, valid or not, for any source (the
 * `stripHookContent` pattern). The Steward sink strips it once it parsed
 * the event; the ingest strips it again before it stores the batch, so the
 * rule holds whichever sinks ran (C-186). The API keeps no copy: the kind,
 * the reason and the actions are what it stores.
 */
export const stripStewardContent = (event: RunnerEvent): void => {
  if (!isStewardEventType(event.type)) return;
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  if (!('paneTail' in data)) return;
  const { paneTail: _tail, ...kept } = data as Record<string, unknown>;
  event.data = kept;
};
