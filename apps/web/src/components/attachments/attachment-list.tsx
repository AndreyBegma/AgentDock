'use client';

import type { AttachmentView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { FileItem } from '@andrewbehma/glass-ui/file-item';
import {
  attachmentHref,
  canRemoveAttachment,
  isImageMime,
} from '../../lib/attachments/format';
import { Time } from '../../lib/format/time';

/**
 * The saved attachments of a card or of one round (#309 D13): `FileItem` rows,
 * an image thumbnail that opens the bytes in a new tab, Download for the rest,
 * and Remove for the uploader or an admin.
 */
export function AttachmentList({
  attachments,
  user,
  canRemove,
  removing,
  onRemove,
}: {
  attachments: readonly AttachmentView[];
  user: { id: string; role: string };
  /** False for a viewer and for a card in Completed. */
  canRemove: boolean;
  /** The id being removed. */
  removing?: string;
  onRemove: (attachment: AttachmentView) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {attachments.map((a) => {
        const href = attachmentHref(a);
        const image = isImageMime(a.mime);
        return (
          <li key={a.id}>
            <FileItem
              name={a.name}
              size={a.size}
              mime={a.mime}
              thumbnailUrl={image ? href : undefined}
              status="done"
              meta={
                <span className="text-xs text-ink-3">
                  {a.uploaderName ? `${a.uploaderName} · ` : ''}
                  <Time value={a.createdAt} />
                </span>
              }
              actions={
                <span className="flex gap-1">
                  <a
                    href={href}
                    target={image ? '_blank' : undefined}
                    rel={image ? 'noreferrer' : undefined}
                    download={image ? undefined : a.name}
                    className="rounded-control px-2 py-1 text-xs text-accent-ink underline-offset-2 hover:underline"
                  >
                    {image ? 'Open' : 'Download'}
                  </a>
                  {canRemove && canRemoveAttachment(a, user) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={removing === a.id}
                      onClick={() => onRemove(a)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </span>
              }
            />
          </li>
        );
      })}
    </ul>
  );
}
