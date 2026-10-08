import type { ApprovalSource, ApprovalStatus } from '@agentdock/shared';
import {
  type PrChecks,
  parseFleetEvent,
  type RunnerEvent,
} from '@agentdock/shared/protocol';

/**
 * The approval rules of spec 20 as pure functions: which events of a batch
 * concern which pull request (D2), and what each does to the PR's current row.
 */

/** The plugin's event (plugin#8): forwarded raw, `data.pr` in its own naming. */
export const AWAITING_APPROVAL_EVENT = 'pr.awaiting_approval';

/** What one batch said about one pull request. */
export interface PrTouch {
  /** The last `pr.awaiting_approval`. */
  awaiting: { slot: string | null; issue: number | null; ts: string } | null;
  /** `pr.merged`, or `pr.closed` (merged or not). */
  closed: 'merged' | 'closed' | null;
  /** A `pr.opened`, `pr.checks_changed` or `pull request open` checkpoint. */
  moved: boolean;
}

/** What one batch said about one project root. */
export interface RootTouch {
  prs: Map<number, PrTouch>;
  /** Slots with a `pull request open` checkpoint but no PR number in it. */
  checkpointSlots: Set<string>;
  /** The batch itself carries a `code-sentinel` event for the root. */
  pluginEvent: boolean;
}

const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : null;

const touchOf = (root: RootTouch, pr: number): PrTouch => {
  let touch = root.prs.get(pr);
  if (!touch) {
    touch = { awaiting: null, closed: null, moved: false };
    root.prs.set(pr, touch);
  }
  return touch;
};

/**
 * Groups a batch's approval-relevant events by project root and PR, in `seq`
 * order. Events that do not fit are skipped; the fleet projector logs them.
 */
export const readApprovalEvents = (
  events: readonly RunnerEvent[],
): Map<string, RootTouch> => {
  const roots = new Map<string, RootTouch>();
  const rootOf = (path: string): RootTouch => {
    let root = roots.get(path);
    if (!root) {
      root = { prs: new Map(), checkpointSlots: new Set(), pluginEvent: false };
      roots.set(path, root);
    }
    return root;
  };

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!event.project) continue;
    if (event.source === 'code-sentinel') {
      rootOf(event.project.root).pluginEvent = true;
    }
    if (event.type === AWAITING_APPROVAL_EVENT) {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const pr = positiveInt(data.pr) ?? positiveInt(data.number);
      if (!pr) continue;
      touchOf(rootOf(event.project.root), pr).awaiting = {
        slot: event.slot ?? null,
        issue: event.issue ?? null,
        ts: event.ts,
      };
      continue;
    }
    const parsed = parseFleetEvent(event);
    if (!parsed?.ok) continue;
    const fleet = parsed.event;
    const root = rootOf(event.project.root);
    switch (fleet.type) {
      case 'pr.opened':
      case 'pr.checks_changed':
        touchOf(root, fleet.data.number).moved = true;
        break;
      case 'pr.merged':
        touchOf(root, fleet.data.number).closed = 'merged';
        break;
      case 'pr.closed':
        touchOf(root, fleet.data.number).closed =
          fleet.data.merged === true ? 'merged' : 'closed';
        break;
      case 'slot.checkpoint':
        if (fleet.data.checkpoint !== 'pr_open') break;
        if (fleet.data.prNumber) {
          touchOf(root, fleet.data.prNumber).moved = true;
        } else if (fleet.slot) {
          root.checkpointSlots.add(fleet.slot);
        }
        break;
      default:
        break;
    }
  }
  return roots;
};

/** A PR's current row, as the rules need it. */
export interface CurrentRow {
  id: string;
  status: Extract<ApprovalStatus, 'waiting' | 'approved'>;
  source: ApprovalSource;
}

/** The PR's slot after the fleet projector applied the batch (#11). */
export interface SlotState {
  prState: 'open' | 'merged' | 'closed' | null;
  prChecks: PrChecks | null;
  prMergeable: boolean | null;
  ended: boolean;
  /** The slot has a `pull request open` checkpoint (D2, D3). */
  prOpenCheckpoint: boolean;
}

/** D2's derived condition: green, mergeable, open, with a `pr_open` checkpoint. */
export const awaitsByDerivation = (slot: SlotState): boolean =>
  !slot.ended &&
  slot.prState === 'open' &&
  slot.prChecks === 'green' &&
  slot.prMergeable === true &&
  slot.prOpenCheckpoint;

export type PrAction =
  | { kind: 'close'; rowId: string; status: 'merged' | 'closed' }
  | {
      kind: 'create';
      source: ApprovalSource;
      slot: string | null;
      issue: number | null;
      waitingSince: string;
    }
  | {
      kind: 'adopt';
      rowId: string;
      slot: string | null;
      issue: number | null;
    }
  | { kind: 'drop'; rowId: string }
  | { kind: 'checkHead'; rowId: string };

export interface PrPlanInput {
  touch: PrTouch;
  current: CurrentRow | null;
  /** The PR's latest row when its status is `closed`. */
  closedRowId?: string | null;
  slot: { name: string; issue: number | null; state: SlotState } | null;
  /** D2: config `mergeApproval: true` and no plugin events for the project. */
  deriveAllowed: boolean;
  /** The batch's time, for a derived row's `waitingSince`. */
  now: string;
}

/**
 * What a batch does to one PR's rows, in order:
 * - merged or closed: the current row follows, and nothing new opens;
 * - `pr.awaiting_approval`: a `waiting` row (`orchestrator`), or a derived
 *   one adopted as the orchestrator's;
 * - the PR moved (checks, a reopened checkpoint): an `approved` row has its
 *   head re-read (D6); a `waiting` row whose slot is no longer green and
 *   mergeable is dropped — it was never decided; with no current row, D2's
 *   derived condition opens one. Derivation is transition-triggered, so a PR
 *   sent back with "request changes" is listed again only when it moves.
 */
export const planPr = (input: PrPlanInput): PrAction[] => {
  const { touch, current, slot } = input;
  if (touch.closed) {
    if (current) {
      return [{ kind: 'close', rowId: current.id, status: touch.closed }];
    }
    // A `pr.closed` without `merged` came first; the merge corrects it.
    return touch.closed === 'merged' && input.closedRowId
      ? [{ kind: 'close', rowId: input.closedRowId, status: 'merged' }]
      : [];
  }

  const actions: PrAction[] = [];
  let row = current;
  if (touch.awaiting) {
    if (!row) {
      actions.push({
        kind: 'create',
        source: 'orchestrator',
        slot: touch.awaiting.slot ?? slot?.name ?? null,
        issue: touch.awaiting.issue ?? slot?.issue ?? null,
        waitingSince: touch.awaiting.ts,
      });
      // The orchestrator's word stands for this batch.
      return actions;
    }
    if (row.status === 'waiting' && row.source === 'derived') {
      actions.push({
        kind: 'adopt',
        rowId: row.id,
        slot: touch.awaiting.slot,
        issue: touch.awaiting.issue,
      });
      row = { ...row, source: 'orchestrator' };
    }
  }

  if (!touch.moved) return actions;
  if (row?.status === 'approved') {
    actions.push({ kind: 'checkHead', rowId: row.id });
  } else if (row?.status === 'waiting') {
    if (slot && !touch.awaiting && !awaitsByDerivation(slot.state)) {
      actions.push({ kind: 'drop', rowId: row.id });
    }
  } else if (
    !row &&
    input.deriveAllowed &&
    slot &&
    awaitsByDerivation(slot.state)
  ) {
    actions.push({
      kind: 'create',
      source: 'derived',
      slot: slot.name,
      issue: slot.issue,
      waitingSince: input.now,
    });
  }
  return actions;
};
