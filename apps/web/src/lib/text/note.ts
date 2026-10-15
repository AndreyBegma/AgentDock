import type {
  TextFieldView,
  TextNoteReason,
  TextOwnerType,
} from '@agentdock/shared';

/** What a `NormalizedNote` shows under one stored text (#271 "UI"). */
export type NoteModel =
  | { kind: 'none' }
  | { kind: 'normalizing' }
  | { kind: 'original'; original: string }
  | {
      kind: 'not_normalized';
      reason: string;
      /** Retry button: the request failed and the person is an operator. */
      canRetry: boolean;
      normalizationId: string;
    };

const REASON_TEXT: Record<TextNoteReason, string> = {
  runner_offline: 'The runner was offline for too long.',
  runner_unsupported: 'The runner does not support text normalization.',
  no_profile: 'No Claude profile is available for this project.',
  run_failed: 'The translation run failed.',
  contract_violation: 'The model’s answer could not be used.',
  budget_exceeded: 'The project budget stopped the translation.',
  off: 'Normalization is switched off for this project.',
  rejected: 'The translation lost part of the text, so the original stays.',
};

export const describeNoteReason = (
  reason: TextNoteReason | undefined,
): string =>
  reason === undefined ? 'The text was kept as typed.' : REASON_TEXT[reason];

/** The note for one field view; `undefined` (no request ever) shows nothing. */
export const noteModel = (
  view: TextFieldView | undefined,
  canOperate: boolean,
): NoteModel => {
  if (view === undefined) return { kind: 'none' };
  switch (view.status) {
    case 'normalizing':
      return { kind: 'normalizing' };
    case 'normalized':
      return view.original === undefined
        ? { kind: 'none' }
        : { kind: 'original', original: view.original };
    case 'not_normalized':
      return {
        kind: 'not_normalized',
        reason: describeNoteReason(view.reason),
        canRetry: canOperate && view.retryable,
        normalizationId: view.normalizationId,
      };
    case 'english':
      return { kind: 'none' };
  }
};

/** The view of one (owner, field) in a response; the response holds the newest per pair. */
export const findFieldView = (
  fields: readonly TextFieldView[] | undefined,
  ownerType: TextOwnerType,
  ownerId: string,
  field: string,
): TextFieldView | undefined =>
  fields?.find(
    (f) =>
      f.ownerType === ownerType && f.ownerId === ownerId && f.field === field,
  );
