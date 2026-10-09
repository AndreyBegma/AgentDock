import type { HeldForLeadRow, QueueState, QueueVerdict } from './contracts';

/** A board table row keyed by its column header as written (`BoardRow`). */
type Row = Record<string, string>;

/** The four tables of a `round.decided` (`RoundDecisions`). */
export interface BoardDecisions {
  dispatching: Row[];
  heldForLead: Row[];
  notDispatching: Row[];
  inFlight: Row[];
}

const cell = (row: Row, ...names: string[]): string | undefined => {
  const wanted = names.map((n) => n.toLowerCase());
  const key = Object.keys(row).find((k) =>
    wanted.includes(k.trim().toLowerCase()),
  );
  return key === undefined ? undefined : row[key];
};

const clean = (text: string): string =>
  text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

/** The first `#n` of an `Issue` cell (`#19`, `[#19](…)`, `#19 — title`). */
export const boardIssueRef = (text: string | undefined): number | null => {
  const match = text ? /#(\d+)\b/.exec(text) : null;
  return match ? Number(match[1]) : null;
};

/** `BLOCKED — work`, `blocked - work`, `**NO SPEC**` → the state; null when unrecognised. */
export const normalizeBoardState = (text: string): QueueState | null => {
  const key = clean(text)
    .toUpperCase()
    .replace(/[—–-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  switch (key) {
    case 'IN FLIGHT':
      return 'in_flight';
    case 'READY':
      return 'ready';
    case 'BLOCKED WORK':
      return 'blocked_work';
    case 'BLOCKED PERSON':
      return 'blocked_person';
    case 'NO SPEC':
      return 'no_spec';
    default:
      return null;
  }
};

const optional = (text: string | undefined): string | null => {
  const value = text === undefined ? '' : clean(text);
  return value === '' || value === '—' || value === '-' ? null : value;
};

/**
 * The orchestrator's verdict per issue in one round (D4): `Not dispatching`
 * rows carry their state, why and what would clear it; a `Dispatching` or
 * `Already in flight` row is `IN FLIGHT`. A row whose issue or state cannot be
 * read is skipped. The first row naming an issue wins.
 */
export const boardVerdicts = (
  decisions: BoardDecisions,
): Map<number, QueueVerdict> => {
  const verdicts = new Map<number, QueueVerdict>();
  const add = (issue: number | null, verdict: QueueVerdict) => {
    if (issue !== null && !verdicts.has(issue)) verdicts.set(issue, verdict);
  };
  for (const row of decisions.inFlight) {
    add(boardIssueRef(cell(row, 'Issue')), {
      state: 'in_flight',
      why:
        optional(cell(row, 'Where it got to')) ??
        `in flight as ${optional(cell(row, 'Slot / PR')) ?? 'a slot'}`,
      clears: null,
    });
  }
  for (const row of decisions.dispatching) {
    add(boardIssueRef(cell(row, 'Issue')), {
      state: 'in_flight',
      why: `dispatched as ${optional(cell(row, 'Slot')) ?? 'a slot'}`,
      clears: null,
    });
  }
  for (const row of decisions.notDispatching) {
    const state = normalizeBoardState(cell(row, 'State') ?? '');
    if (!state) continue;
    add(boardIssueRef(cell(row, 'Issue')), {
      state,
      why: optional(cell(row, 'Why')) ?? '',
      clears: optional(cell(row, 'What would clear it', 'Clears')),
    });
  }
  return verdicts;
};

/** The `Held for a lead` table (D5); rows without a slot are skipped. */
export const heldForLead = (decisions: BoardDecisions): HeldForLeadRow[] =>
  decisions.heldForLead.flatMap((row) => {
    const slot = optional(cell(row, 'Slot'));
    return slot
      ? [
          {
            slot,
            waitingOn: optional(cell(row, 'Waiting on')) ?? '',
            dispatchWhen: optional(cell(row, 'Dispatch when')) ?? '',
          },
        ]
      : [];
  });
