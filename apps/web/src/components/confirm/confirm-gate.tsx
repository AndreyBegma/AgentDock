'use client';

import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';

/** The words of one confirmation: a question, what happens, the one-word answer. */
export interface ConfirmCopy {
  title: string;
  consequence: string;
  verb: string;
  /** Default `danger`: the focus lands on Cancel. */
  tone?: 'danger' | 'default';
}

/**
 * C-166: a one-click action that grants a role, removes something or starts a
 * run asks first. The caller keeps what is waiting for an answer in `pending`
 * — the button only sets it — and the work runs from `onConfirm` alone.
 *
 * Hook-free on purpose: a test calls it as a function and presses the returned
 * `ConfirmDialog`'s answers, which the web tests cannot do through a DOM.
 */
export function ConfirmGate<T>({
  pending,
  copy,
  busy = false,
  onConfirm,
  onCancel,
}: {
  pending: T | undefined;
  copy: (pending: T) => ConfirmCopy;
  busy?: boolean;
  onConfirm: (pending: T) => void;
  onCancel: () => void;
}) {
  if (pending === undefined) return null;
  const words = copy(pending);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={words.title}
      consequence={words.consequence}
      verb={words.verb}
      tone={words.tone ?? 'danger'}
      busy={busy}
      onConfirm={() => onConfirm(pending)}
    />
  );
}
