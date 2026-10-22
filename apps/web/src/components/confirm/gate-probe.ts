import type { ConfirmDialogProps } from '@andrewbehma/glass-ui/confirm-dialog';
import { isValidElement } from 'react';
import { type ConfirmCopy, ConfirmGate } from './confirm-gate';

/**
 * Test helper: renders a `ConfirmGate` without a DOM and hands back its
 * dialog's props and both answers, recording what reached `onConfirm`.
 */
export function probeGate<T>(copy: (pending: T) => ConfirmCopy, pending: T) {
  const confirmed: T[] = [];
  let cancelled = 0;
  const element = ConfirmGate({
    pending,
    copy,
    onConfirm: (p) => confirmed.push(p),
    onCancel: () => cancelled++,
  });
  if (!isValidElement<ConfirmDialogProps>(element)) {
    throw new Error('ConfirmDialog expected');
  }
  return {
    dialog: element.props,
    confirmed,
    cancelled: () => cancelled,
    confirm: () => element.props.onConfirm(),
    cancel: () => element.props.onOpenChange(false),
  };
}

/** The gate with nothing pending draws no dialog and runs nothing. */
export function closedGate<T>(copy: (pending: T) => ConfirmCopy) {
  let calls = 0;
  const element = ConfirmGate<T>({
    pending: undefined,
    copy,
    onConfirm: () => calls++,
    onCancel: () => calls++,
  });
  return { element, calls: () => calls };
}
