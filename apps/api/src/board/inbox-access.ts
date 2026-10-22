import type { Role } from '@nautelle/shared';
import { roleAtLeast } from '@nautelle/shared/protocol';

/**
 * #244 D8: Inbox cards are content-derived, so only operators and above see
 * them (ADR-0021 §5). A role left out is the board's own read: everything.
 */
export const seesInbox = (role: Role | undefined): boolean =>
  role === undefined || roleAtLeast(role, 'operator');

/**
 * Whether a card in `column` is hidden from `role` — the one rule for every
 * read of a card or of what it owns (design, mockups, attachments, texts,
 * dependencies). A hidden card answers 404, as if absent.
 */
export const hiddenFrom = (
  card: { column: string },
  role: Role | undefined,
): boolean => card.column === 'inbox' && !seesInbox(role);
