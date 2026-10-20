'use client';

import {
  TEXT_CHANGED_EVENT,
  type TextFieldView,
  type TextOwnerType,
} from '@nautelle/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLive } from '../live/use-live';
import { fetchTextNotes, retryTextNormalization } from './actions';
import { findFieldView } from './note';

/** Pushes come in bursts; one refetch covers them (as `usePlan`). */
const REFETCH_DEBOUNCE_MS = 250;

export interface TextNotes {
  /** The newest view of one field, or `undefined` when nothing was requested. */
  view: (
    ownerType: TextOwnerType,
    ownerId: string,
    field: string,
  ) => TextFieldView | undefined;
  /** Runs a failed request again; the notes refetch after. */
  retry: (normalizationId: string) => Promise<void>;
  refetch: () => void;
}

/**
 * The normalization notes of one card or one plan: one GET, refetched on the
 * `text.changed` push of this project and whenever `refreshKey` changes (the
 * owner's own data was reloaded, so its text may have a new request). A failed
 * load leaves the notes empty: they are a hint, never a blocker.
 */
export function useTextNotes(
  projectId: string,
  owner: { cardId: string } | { planId: string } | null,
  refreshKey?: unknown,
): TextNotes {
  const [fields, setFields] = useState<TextFieldView[]>([]);
  const [version, setVersion] = useState(0);
  const ownerKey = owner === null ? null : JSON.stringify(owner);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and `refreshKey` are refetch triggers
  useEffect(() => {
    if (ownerKey === null) return;
    let current = true;
    fetchTextNotes(projectId, JSON.parse(ownerKey))
      .then((response) => {
        if (current) setFields(response.fields);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [projectId, ownerKey, version, refreshKey]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLive(ownerKey === null ? null : `project:${projectId}`, (message) => {
    if (message.event !== TEXT_CHANGED_EVENT) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const refetch = useCallback(() => setVersion((v) => v + 1), []);
  const retry = useCallback(
    async (normalizationId: string) => {
      await retryTextNormalization(projectId, normalizationId);
      setVersion((v) => v + 1);
    },
    [projectId],
  );
  const view = useCallback<TextNotes['view']>(
    (ownerType, ownerId, field) =>
      findFieldView(fields, ownerType, ownerId, field),
    [fields],
  );
  return useMemo(() => ({ view, retry, refetch }), [view, retry, refetch]);
}
