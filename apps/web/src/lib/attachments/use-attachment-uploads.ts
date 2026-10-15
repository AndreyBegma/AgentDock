'use client';

import type { AttachmentView } from '@agentdock/shared';
import {
  type UploadItem,
  type UseFileUpload,
  useFileUpload,
} from '@andrewbehma/glass-ui/use-file-upload';
import { useCallback, useMemo } from 'react';
import { removeAttachment } from './actions';
import { csrfHeaders, uploadedView, uploadUrl } from './format';

export interface AttachmentUploads {
  upload: UseFileUpload;
  /** Finished uploads, pending on the server until a card or feedback claims them. */
  done: { item: UploadItem; view: AttachmentView }[];
  /** A request is queued or running. */
  busy: boolean;
  /** Drops a row; a finished one is also deleted from the server (it was never claimed). */
  discard: (item: UploadItem) => void;
  /** Forgets every row after its uploads were claimed (nothing is deleted). */
  forget: (items: readonly UploadItem[]) => void;
}

/** `useFileUpload` pointed at this project's upload route, with the CSRF header (D12). */
export function useAttachmentUploads(projectId: string): AttachmentUploads {
  const upload = useFileUpload({
    url: uploadUrl(projectId),
    headers: csrfHeaders(
      typeof document === 'undefined' ? '' : document.cookie,
    ),
    withCredentials: true,
  });
  const { items, remove } = upload;

  const done = useMemo(
    () =>
      items.flatMap((item) => {
        if (item.state.status !== 'done') return [];
        const view = uploadedView(item.state.response);
        return view ? [{ item, view }] : [];
      }),
    [items],
  );
  const busy = items.some(
    (i) => i.state.status === 'queued' || i.state.status === 'uploading',
  );

  const discard = useCallback(
    (item: UploadItem) => {
      remove(item.id);
      if (item.state.status !== 'done') return;
      const view = uploadedView(item.state.response);
      // Best effort: the sweep deletes a pending upload within 24 h anyway.
      if (view) void removeAttachment(projectId, view.id).catch(() => {});
    },
    [projectId, remove],
  );

  const forget = useCallback(
    (list: readonly UploadItem[]) => {
      for (const item of list) remove(item.id);
    },
    [remove],
  );

  return { upload, done, busy, discard, forget };
}
