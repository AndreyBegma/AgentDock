import {
  type HandoffLineRange,
  type HandoffRejection,
  type HandoffUpdatedBy,
  validateHandoffNote,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';

export const UPDATED_BY_LABEL: Record<HandoffUpdatedBy, string> = {
  agent: 'the agent',
  haiku: 'haiku, from the transcript',
  person: 'a person',
};

/** Whether 1-based line `n` of the note is one a person wrote (D7). */
export const isPersonLine = (
  n: number,
  ranges: readonly HandoffLineRange[],
): boolean => ranges.some((r) => n >= r.from && n <= r.to);

export interface NoteBlock {
  /** 1-based line number in the note. */
  line: number;
  text: string;
  person: boolean;
}

/** The note's lines with the person's marked, for display. */
export const noteBlocks = (
  content: string,
  ranges: readonly HandoffLineRange[],
): NoteBlock[] =>
  content.split('\n').map((text, i) => ({
    line: i + 1,
    text,
    person: isPersonLine(i + 1, ranges),
  }));

export interface NoteGroup {
  /** The `## ` heading text; null for text before the first section. */
  heading: string | null;
  lines: NoteBlock[];
}

/** The note as sections of lines (a fenced `## ` is not a heading). */
export function noteGroups(
  content: string,
  ranges: readonly HandoffLineRange[],
): NoteGroup[] {
  const groups: NoteGroup[] = [];
  let fenced = false;
  for (const block of noteBlocks(content, ranges)) {
    if (/^\s*(```|~~~)/.test(block.text)) fenced = !fenced;
    const heading = fenced ? null : /^## (.*)$/.exec(block.text.trimEnd());
    if (heading) {
      groups.push({ heading: heading[1].trim(), lines: [] });
      continue;
    }
    let group = groups.at(-1);
    if (!group) {
      group = { heading: null, lines: [] };
      groups.push(group);
    }
    group.lines.push(block);
  }
  for (const group of groups) {
    while (group.lines.at(-1)?.text.trim() === '') group.lines.pop();
    while (group.lines[0]?.text.trim() === '') group.lines.shift();
  }
  return groups.filter((g) => g.heading !== null || g.lines.length > 0);
}

const reasonsOf = (error: ApiError): HandoffRejection[] => {
  const reasons = error.body?.reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.flatMap((r): HandoffRejection[] =>
    r &&
    typeof r === 'object' &&
    typeof (r as { message?: unknown }).message === 'string'
      ? [r as HandoffRejection]
      : [],
  );
};

export interface HandoffFailure {
  message: string;
  /** 422 `invalid_note`: every reason, so one rewrite fixes them all. */
  reasons: string[];
}

/** What the editor shows for a failed `GET` or `PUT` (#449 "API" statuses). */
export function describeHandoffError(error: unknown): HandoffFailure {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return {
        message:
          'The note cannot be edited now: this project keeps session content on the machine, or the card has no worktree yet (its first round writes the note).',
        reasons: [],
      };
    }
    if (error.status === 422 && error.body?.error === 'invalid_note') {
      const reasons = reasonsOf(error).map((r) => r.message);
      return {
        message: 'The note was not saved: it does not follow the format.',
        reasons: reasons.length > 0 ? reasons : [error.message],
      };
    }
    if (error.status === 503) {
      return {
        message:
          'The runner is offline or too old to apply the edit. The note was not changed.',
        reasons: [],
      };
    }
    if (error.status === 502) {
      return {
        message: `The runner could not apply the note: ${error.message}`,
        reasons: [],
      };
    }
    if (error.status === 403) {
      return { message: 'Only operators can edit the note.', reasons: [] };
    }
    if (error.status === 404) {
      return {
        message:
          'That card was not found, or you are not a member of its project.',
        reasons: [],
      };
    }
  }
  return { message: describeError(error), reasons: [] };
}

/** The format problems a draft has, before the API is asked. */
export function draftProblems(content: string): string[] {
  const result = validateHandoffNote(content.replace(/\r\n?/g, '\n'));
  return result.ok ? [] : result.reasons.map((r) => r.message);
}
