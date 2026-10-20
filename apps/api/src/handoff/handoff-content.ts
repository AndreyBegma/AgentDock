import {
  HANDOFF_UPDATED_EVENT,
  type HandoffLineRange,
  type HandoffUpdatedBy,
  personLinesKept,
  splitPersonMarks,
} from '@nautelle/shared';
import type { RunnerEvent } from '@nautelle/shared/protocol';

/** The `data` keys of `handoff.updated` that carry the note (#449 DA-12). */
const NOTE_KEYS = ['content', 'personLines'] as const;

/**
 * #449 DA-12: a note's text never reaches `events.data`. The ingest removes
 * the note keys from every `handoff.updated` in the batch, in place, after
 * the sinks ran and before it stores the batch — for any source, valid or
 * not, so a malformed or forged event cannot carry the text in either.
 */
export const stripHandoffContent = (event: RunnerEvent): void => {
  if (event.type !== HANDOFF_UPDATED_EVENT) return;
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  const kept: Record<string, unknown> = { ...data };
  for (const key of NOTE_KEYS) delete kept[key];
  event.data = kept;
};

/**
 * #449 DA-05: a note's content without person marks. The API's `personLines`
 * are the only record of what a person wrote, so a mark in what the runner
 * or a person sends is text to drop, never a claim to honour.
 */
export const unmarked = (content: string): string =>
  splitPersonMarks(content).content;

/** The API's copy of a note, as far as an update needs it. */
export interface StoredNote {
  content: string;
  personLines: HandoffLineRange[];
  updatedBy: HandoffUpdatedBy;
}

export type NoteUpdate =
  | {
      kind: 'store';
      content: string;
      personLines: HandoffLineRange[];
      updatedBy: HandoffUpdatedBy;
    }
  /** The copy already holds this note — the runner's echo of a person's edit. */
  | { kind: 'unchanged' }
  /** The rewrite dropped or changed a person line (D7); the copy is kept. */
  | { kind: 'refused'; missing: string[] };

/**
 * #449 DA-05: what an incoming note does to the API's copy. The marks are
 * dropped and the event's own ranges ignored; the stored person lines are
 * found again in the new content (re-anchored). `person` is believed only
 * for the content a person's PUT stored — anything else is the agent's.
 */
export const applyNoteUpdate = (
  stored: StoredNote | null,
  incoming: { content: string; updatedBy: HandoffUpdatedBy },
): NoteUpdate => {
  const content = unmarked(incoming.content);
  if (stored && stored.content === content) return { kind: 'unchanged' };
  const updatedBy =
    incoming.updatedBy === 'person' ? 'agent' : incoming.updatedBy;
  if (!stored) return { kind: 'store', content, personLines: [], updatedBy };
  const kept = personLinesKept(stored.content, stored.personLines, content);
  if (!kept.ok) return { kind: 'refused', missing: kept.missing };
  return { kind: 'store', content, personLines: kept.personLines, updatedBy };
};
