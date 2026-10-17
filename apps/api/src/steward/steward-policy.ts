import {
  STEWARD_NUDGE_MAX_PER_ROUND,
  STEWARD_NUDGE_REPEAT_DELAY_MS,
  STEWARD_RESUME_MAX_PER_ROUND,
  type StewardActionRecord,
  type StewardDialogId,
  type StewardIncidentKind,
  type StewardSettings,
  type StewardSubjectKind,
  stewardActionCount,
} from '@agentdock/shared';

/**
 * The `detail` of an attempt claimed but not answered yet. The runner's
 * answer, or its `steward.acted`, replaces it.
 */
export const PENDING_DETAIL = 'sent, waiting for the runner';

/** What an incident's subject allows right now, as the decider read it. */
export interface PolicyInput {
  subjectKind: StewardSubjectKind;
  kind: StewardIncidentKind;
  /** This incident's actions, oldest first. */
  actions: readonly StewardActionRecord[];
  /** Every action on the subject's incidents — the per-round limits (D9, D10). */
  roundActions: readonly StewardActionRecord[];
  settings: Pick<StewardSettings, 'autoNudge' | 'autoDismiss' | 'autoResume'>;
  /** The dialog the runner named, for `dialog` (D11). */
  dialogId: StewardDialogId | null;
  now: Date;
}

export type PolicyStep =
  | { step: 'nudge' }
  | { step: 'dismiss'; dialogId: StewardDialogId }
  | { step: 'resume' }
  | { step: 'wait'; until: Date | null }
  | { step: 'escalate' }
  | { step: 'none' };

const ESCALATE: PolicyStep = { step: 'escalate' };

const pending = (actions: readonly StewardActionRecord[]): boolean =>
  actions.some((a) => a.detail === PENDING_DETAIL);

/**
 * #447 D4, D9–D11: the next thing Steward does about an open incident.
 * Pure. Only nudge, dismiss and resume are automatic, each under its switch
 * and its per-round limit; everything else — a permission prompt, an
 * unknown dialog, quota, silence, haiku's unknown, any fleet slot — goes to
 * a person at once. A trailer is the runner's to hold (D7): nothing to do.
 */
export const nextStep = (input: PolicyInput): PolicyStep => {
  // D5: the fleet is observe-only.
  if (input.subjectKind === 'fleet_slot') return ESCALATE;
  if (pending(input.actions)) return { step: 'wait', until: null };
  switch (input.kind) {
    case 'api_error': {
      if (!input.settings.autoNudge) return ESCALATE;
      const nudges = input.roundActions.filter((a) => a.action === 'nudge');
      if (nudges.length >= STEWARD_NUDGE_MAX_PER_ROUND) return ESCALATE;
      const last = nudges.at(-1);
      if (last) {
        const due = new Date(
          Date.parse(last.at) + STEWARD_NUDGE_REPEAT_DELAY_MS,
        );
        if (input.now < due) return { step: 'wait', until: due };
      }
      return { step: 'nudge' };
    }
    case 'dialog':
      if (
        !input.settings.autoDismiss ||
        input.dialogId === null ||
        stewardActionCount(input.actions, 'dismiss') > 0
      ) {
        return ESCALATE;
      }
      return { step: 'dismiss', dialogId: input.dialogId };
    case 'dead_session':
      if (
        input.subjectKind !== 'card_round' ||
        !input.settings.autoResume ||
        stewardActionCount(input.roundActions, 'resume') >=
          STEWARD_RESUME_MAX_PER_ROUND
      ) {
        return ESCALATE;
      }
      return { step: 'resume' };
    case 'trailer':
      return { step: 'none' };
    case 'permission_prompt':
    case 'quota':
    case 'silent':
    case 'unknown':
      return ESCALATE;
  }
};
