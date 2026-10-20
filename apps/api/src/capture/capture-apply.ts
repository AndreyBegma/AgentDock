import {
  type BoardColumn,
  CAPTURE_COMPLETED_DEDUPE_DAYS,
  CAPTURE_DISMISSAL_DEDUPE_DAYS,
  CAPTURE_EVIDENCE_EXCERPT_MAX,
  type CaptureSelection,
  type CaptureSuggestion,
  type CardEvidenceView,
  captureFingerprint,
  type FingerprintedSuggestion,
  selectCaptureCards,
} from '@nautelle/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A card of the project, as dedupe reads it. */
export interface DedupeCard {
  title: string;
  /** `null` on a card written before #244: computed from the title. */
  fingerprint: string | null;
  column: BoardColumn;
  completedAt: Date | null;
}

export interface DedupeDismissal {
  fingerprint: string;
  createdAt: Date;
}

/**
 * D6 (issue #244): the fingerprints a suggestion must not repeat — every card
 * not completed (the Inbox included), a card completed within
 * `CAPTURE_COMPLETED_DEDUPE_DAYS`, a dismissal within
 * `CAPTURE_DISMISSAL_DEDUPE_DAYS`.
 */
export const knownFingerprints = (
  cards: readonly DedupeCard[],
  dismissals: readonly DedupeDismissal[],
  now: Date,
): Set<string> => {
  const completedSince = now.getTime() - CAPTURE_COMPLETED_DEDUPE_DAYS * DAY_MS;
  const dismissedSince = now.getTime() - CAPTURE_DISMISSAL_DEDUPE_DAYS * DAY_MS;
  const known = new Set<string>();
  for (const card of cards) {
    const recent =
      card.column !== 'completed' ||
      (card.completedAt !== null &&
        card.completedAt.getTime() >= completedSince);
    if (recent) known.add(card.fingerprint ?? captureFingerprint(card.title));
  }
  for (const dismissal of dismissals) {
    if (dismissal.createdAt.getTime() >= dismissedSince) {
      known.add(dismissal.fingerprint);
    }
  }
  return known;
};

export interface CapturePlan extends CaptureSelection {
  /** Kept, but over the Inbox's room. */
  overflow: FingerprintedSuggestion[];
}

/**
 * D6 and D7: the suggestions that become Inbox cards — `selectCaptureCards`
 * against `known`, then at most `room` of them (the Inbox's free places),
 * in the model's order.
 */
export const planCaptureApply = (
  cards: readonly CaptureSuggestion[],
  known: ReadonlySet<string>,
  room: number,
): CapturePlan => {
  const selection = selectCaptureCards(cards, known);
  const fits = Math.max(0, room);
  return {
    kept: selection.kept.slice(0, fits),
    dropped: selection.dropped,
    overflow: selection.kept.slice(fits),
  };
};

/** A content row an evidence id points at. */
export interface EvidenceSource {
  kind: string;
  text: string;
}

/**
 * D8: an Inbox card's evidence — per content id, at most
 * `CAPTURE_EVIDENCE_EXCERPT_MAX` characters: a prompt's head, a response's
 * tail, as the extraction read them. An id whose row is gone is left out.
 */
export const evidenceExcerpts = (
  ids: readonly string[],
  sources: ReadonlyMap<string, EvidenceSource>,
): CardEvidenceView[] =>
  ids.flatMap((contentId): CardEvidenceView[] => {
    const row = sources.get(contentId);
    if (!row || (row.kind !== 'prompt' && row.kind !== 'response')) return [];
    const chars = Array.from(row.text.trim());
    const excerpt =
      row.kind === 'prompt'
        ? chars.slice(0, CAPTURE_EVIDENCE_EXCERPT_MAX).join('')
        : chars.slice(-CAPTURE_EVIDENCE_EXCERPT_MAX).join('');
    return [{ contentId, kind: row.kind, excerpt }];
  });
