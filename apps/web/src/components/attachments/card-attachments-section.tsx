'use client';

import type { AttachmentView } from '@agentdock/shared';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { describeUploadFailure } from '../../lib/attachments/format';
import { useAttachmentUploads } from '../../lib/attachments/use-attachment-uploads';
import { usePasteFiles } from '../../lib/attachments/use-paste-files';
import { claimCardAttachments } from '../../lib/board/actions';
import { describeBoardError } from '../../lib/board/format';
import { AttachmentDropzone } from './attachment-dropzone';
import { AttachmentList } from './attachment-list';

/**
 * The card sheet's Attachments section (#309 UI): the card's own files, a
 * dropzone that claims an upload onto the card the moment it finishes, and
 * paste anywhere in the open sheet. A card in Completed is read-only.
 */
export function CardAttachmentsSection({
  projectId,
  number,
  attachments,
  user,
  canOperate,
  completed,
  removing,
  onRemove,
  onChanged,
}: {
  projectId: string;
  number: number;
  /** The card's own attachments (`roundId` null). */
  attachments: readonly AttachmentView[];
  user: { id: string; role: string };
  canOperate: boolean;
  completed: boolean;
  removing?: string;
  onRemove: (attachment: AttachmentView) => void;
  onChanged: () => void;
}) {
  const uploads = useAttachmentUploads(projectId);
  const [claiming, setClaiming] = useState(false);
  const editable = canOperate && !completed;

  usePasteFiles(editable, uploads.upload.add);

  // Claim every finished upload as soon as nothing else is claiming.
  const { done, forget } = uploads;
  useEffect(() => {
    if (done.length === 0 || claiming) return;
    setClaiming(true);
    const batch = done;
    claimCardAttachments(projectId, number, {
      attachmentIds: batch.map((d) => d.view.id),
    })
      .then(() => {
        forget(batch.map((d) => d.item));
        onChanged();
      })
      .catch((err: unknown) => {
        // The rows go: a refused claim would loop, and the sentence says why.
        forget(batch.map((d) => d.item));
        toast.error(
          err instanceof ApiError
            ? describeUploadFailure(err.status, err.body)
            : describeBoardError(err),
        );
      })
      .finally(() => {
        setClaiming(false);
      });
  }, [done, claiming, forget, projectId, number, onChanged]);

  return (
    <section aria-label="Attachments" className="flex flex-col gap-3">
      <SectionHeader title="Attachments" headingLevel={3} />
      <AttachmentList
        attachments={attachments}
        user={user}
        canRemove={editable}
        removing={removing}
        onRemove={onRemove}
      />
      {attachments.length === 0 && !editable ? (
        <p className="text-sm text-ink-3">No attachments.</p>
      ) : null}
      {editable ? (
        <AttachmentDropzone
          uploads={uploads}
          label="Attach files to this card"
          pasteTarget="none"
          hideQueue
        />
      ) : null}
    </section>
  );
}
