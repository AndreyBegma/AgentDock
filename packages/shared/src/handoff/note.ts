import { z } from 'zod';

/**
 * The handoff note's format (#449 D5, ADR-0042): markdown with fixed `## `
 * sections, in this order, at most `HANDOFF_NOTE_MAX_TOKENS`. The runner
 * validates every note the agent or haiku writes and sends an invalid one
 * back with `handoffRejectionText`; the API validates a person's edit the
 * same way. Text before the first section (a `# ` title) is allowed.
 */

export const HANDOFF_SECTIONS = [
  'Goal',
  'Done',
  'Next',
  'Decisions and why',
  'Dead ends',
  'Files touched',
  'How to verify',
  'Checklist status',
  'Open questions',
] as const;
export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];

/** D5: "at most ~3k tokens". */
export const HANDOFF_NOTE_MAX_TOKENS = 3_000;

/**
 * The estimate's ratio. Rough on purpose: the cap keeps upkeep cheap, it is
 * not a bill, and the same estimate runs on the runner, the API and the web.
 */
export const HANDOFF_CHARS_PER_TOKEN = 4;

/** `HANDOFF_NOTE_MAX_TOKENS` in characters — the largest note that passes. */
export const HANDOFF_NOTE_MAX_CHARS =
  HANDOFF_NOTE_MAX_TOKENS * HANDOFF_CHARS_PER_TOKEN;

export const estimateHandoffTokens = (content: string): number =>
  Math.ceil(content.length / HANDOFF_CHARS_PER_TOKEN);

/** The heading line of a section, as a note writes it. */
export const handoffHeading = (section: HandoffSection): string =>
  `## ${section}`;

/** An empty note with every section — what the prompt asks the agent to fill. */
export const HANDOFF_NOTE_TEMPLATE = `${HANDOFF_SECTIONS.map(
  (section) => `${handoffHeading(section)}\n`,
).join('\n')}`;

/** One section of a parsed note; `body` is trimmed. */
export interface HandoffNoteSection {
  section: HandoffSection;
  body: string;
}

export type HandoffRejectionCode =
  | 'too_large'
  | 'missing_section'
  | 'duplicate_section'
  | 'unknown_section'
  | 'out_of_order'
  | 'empty_goal';

export interface HandoffRejection {
  code: HandoffRejectionCode;
  /** The heading concerned; absent for `too_large`. */
  section?: string;
  /** One line, written for the agent that has to fix the note. */
  message: string;
}

export type HandoffValidation =
  | { ok: true; sections: HandoffNoteSection[] }
  | { ok: false; reasons: HandoffRejection[] };

const SECTION_BY_KEY = new Map<string, HandoffSection>(
  HANDOFF_SECTIONS.map((section) => [section.toLowerCase(), section]),
);

const HEADING = /^## (.*)$/;
const FENCE = /^\s*(```|~~~)/;

interface RawSection {
  heading: string;
  section: HandoffSection | null;
  lines: string[];
}

/** `## ` headings outside code fences, with the lines under each. */
const splitSections = (content: string): RawSection[] => {
  const sections: RawSection[] = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line.trimEnd());
    if (heading) {
      const text = heading[1].trim();
      sections.push({
        heading: text,
        section: SECTION_BY_KEY.get(text.toLowerCase()) ?? null,
        lines: [],
      });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  return sections;
};

/**
 * Checks a note against D5: size, every section once, nothing else, in
 * order, and a Goal. Headings match case-insensitively. Every reason is
 * returned, so one rewrite can fix them all.
 */
export const validateHandoffNote = (content: string): HandoffValidation => {
  const reasons: HandoffRejection[] = [];
  const tokens = estimateHandoffTokens(content);
  if (tokens > HANDOFF_NOTE_MAX_TOKENS) {
    reasons.push({
      code: 'too_large',
      message: `the note is about ${tokens} tokens; shorten it to at most ${HANDOFF_NOTE_MAX_TOKENS}`,
    });
  }

  const raw = splitSections(content);
  const seen = new Set<HandoffSection>();
  const found: HandoffNoteSection[] = [];
  for (const { heading, section, lines } of raw) {
    if (!section) {
      reasons.push({
        code: 'unknown_section',
        section: heading,
        message: `"## ${heading}" is not a handoff section; use only: ${HANDOFF_SECTIONS.join(', ')}`,
      });
      continue;
    }
    if (seen.has(section)) {
      reasons.push({
        code: 'duplicate_section',
        section,
        message: `"## ${section}" appears more than once; merge it into one section`,
      });
      continue;
    }
    seen.add(section);
    found.push({ section, body: lines.join('\n').trim() });
  }

  for (const section of HANDOFF_SECTIONS) {
    if (!seen.has(section)) {
      reasons.push({
        code: 'missing_section',
        section,
        message: `"## ${section}" is missing; add it, with "none" if there is nothing to say`,
      });
    }
  }

  const order = found.map((s) => HANDOFF_SECTIONS.indexOf(s.section));
  const firstOutOfOrder = order.findIndex(
    (at, i) => i > 0 && at < order[i - 1],
  );
  if (firstOutOfOrder > 0) {
    reasons.push({
      code: 'out_of_order',
      section: found[firstOutOfOrder].section,
      message: `sections are out of order; keep this order: ${HANDOFF_SECTIONS.join(', ')}`,
    });
  }

  const goal = found.find((s) => s.section === 'Goal');
  if (goal && goal.body === '') {
    reasons.push({
      code: 'empty_goal',
      section: 'Goal',
      message: '"## Goal" is empty; say in a line or two what the work is for',
    });
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, sections: found };
};

/** The message the runner sends back with an invalid note (D5). */
export const handoffRejectionText = (reasons: HandoffRejection[]): string =>
  [
    'The handoff note was not accepted. Rewrite .agentdock/handoff.md and fix:',
    ...reasons.map((r) => `- ${r.message}`),
  ].join('\n');

/** The note's sections for display, or `null` when the note is not valid. */
export const parseHandoffNote = (
  content: string,
): HandoffNoteSection[] | null => {
  const validation = validateHandoffNote(content);
  return validation.ok ? validation.sections : null;
};

/** A note's content on the wire: bounded, and valid by D5. */
export const handoffContentSchema = z
  .string()
  .max(HANDOFF_NOTE_MAX_CHARS)
  .superRefine((content, ctx) => {
    const validation = validateHandoffNote(content);
    if (validation.ok) return;
    for (const reason of validation.reasons) {
      ctx.addIssue({ code: 'custom', message: reason.message });
    }
  });
