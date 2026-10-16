import { readFileSync, statSync } from 'node:fs';
import {
  HANDOFF_NOTE_MAX_CHARS,
  type HandoffLineRange,
  handoffRejectionText,
  markPersonLines,
  personLinesKept,
  splitPersonMarks,
  validateHandoffNote,
} from '@agentdock/shared';
import type { StoredNote } from './state';

/**
 * Reading a note someone other than the runner wrote (#449 D5, D7): the agent
 * in its session, or haiku. The file's person marks are stripped and never
 * believed — the person's lines are the stored note's (DA-05) — and the
 * content must be a valid note that keeps every one of them.
 */

/** A file this much larger than the cap is not read at all. */
const NOTE_READ_MAX_BYTES = HANDOFF_NOTE_MAX_CHARS * 4;

export type NoteReading =
  /** No note file. */
  | { kind: 'missing' }
  /** The stored note, as it was. */
  | { kind: 'unchanged' }
  /** Not accepted; `text` is what the agent is told. */
  | { kind: 'refused'; content: string; text: string }
  | { kind: 'accepted'; content: string; personLines: HandoffLineRange[] };

export const readNoteFile = (
  path: string,
): { text: string; mtimeMs: number } | null => {
  try {
    const stat = statSync(path);
    if (stat.size > NOTE_READ_MAX_BYTES) {
      return {
        text: 'x'.repeat(HANDOFF_NOTE_MAX_CHARS + 1),
        mtimeMs: stat.mtimeMs,
      };
    }
    return { text: readFileSync(path, 'utf8'), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
};

/** The person lines a rewrite dropped, as the agent is told of them. */
export const personLinesDroppedText = (missing: readonly string[]): string =>
  [
    'The handoff note was not accepted: these lines are instructions from a person and must stay in .agentdock/handoff.md word for word. Put them back:',
    ...missing.map((line) => `- ${line.trim()}`),
  ].join('\n');

/**
 * Judges a note's text against the stored note. Marks are stripped first,
 * whatever they say; the stored person lines must all be there.
 */
export const judgeNote = (
  raw: string,
  stored: StoredNote | null,
): Exclude<NoteReading, { kind: 'missing' }> => {
  const { content } = splitPersonMarks(raw.replace(/\r\n/g, '\n'));
  if (stored && content.trimEnd() === stored.content.trimEnd()) {
    return { kind: 'unchanged' };
  }
  const validation = validateHandoffNote(content);
  if (!validation.ok) {
    return {
      kind: 'refused',
      content,
      text: handoffRejectionText(validation.reasons),
    };
  }
  if (!stored || stored.personLines.length === 0) {
    return { kind: 'accepted', content, personLines: [] };
  }
  const kept = personLinesKept(stored.content, stored.personLines, content);
  if (!kept.ok) {
    return {
      kind: 'refused',
      content,
      text: personLinesDroppedText(kept.missing),
    };
  }
  return { kind: 'accepted', content, personLines: kept.personLines };
};

/** Reads and judges the note at `path`. */
export const readNote = (
  path: string,
  stored: StoredNote | null,
): NoteReading => {
  const file = readNoteFile(path);
  if (!file) return { kind: 'missing' };
  return judgeNote(file.text, stored);
};

/** The note as written to disk: the person's lines carry the mark. */
export const noteFileText = (note: {
  content: string;
  personLines: readonly HandoffLineRange[];
}): string => {
  const text = markPersonLines(note.content, note.personLines);
  return text.endsWith('\n') ? text : `${text}\n`;
};
