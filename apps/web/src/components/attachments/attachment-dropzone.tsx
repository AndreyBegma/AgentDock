'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import {
  FileDropzone,
  type FileRejection,
} from '@andrewbehma/glass-ui/file-dropzone';
import { FileItem } from '@andrewbehma/glass-ui/file-item';
import type { UploadItem } from '@andrewbehma/glass-ui/use-file-upload';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_CARD_MAX,
} from '@nautelle/shared';
import { useState } from 'react';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_NOTE,
  attachmentHref,
  describeRejection,
  describeUploadFailure,
  isImageMime,
  uploadedView,
} from '../../lib/attachments/format';
import type { AttachmentUploads } from '../../lib/attachments/use-attachment-uploads';

/** A refusal (4xx) says the file itself is wrong, so sending it again changes nothing. */
const retryable = (state: UploadItem['state']): boolean =>
  state.status === 'canceled' ||
  (state.status === 'error' &&
    (state.httpStatus === undefined || state.httpStatus >= 500));

/** The `FileItem` row of one upload in flight, finished or failed. */
function UploadRow({
  item,
  uploads,
}: {
  item: UploadItem;
  uploads: AttachmentUploads;
}) {
  const { state, file } = item;
  const { upload, discard } = uploads;
  const view =
    state.status === 'done' ? uploadedView(state.response) : undefined;
  const status =
    state.status === 'queued'
      ? 'uploading'
      : state.status === 'done' ||
          state.status === 'error' ||
          state.status === 'canceled'
        ? state.status
        : 'uploading';
  const progress =
    state.status === 'uploading' && state.total > 0
      ? state.loaded / state.total
      : undefined;
  return (
    <li>
      <FileItem
        name={file.name}
        size={file.size}
        mime={view?.mime ?? file.type}
        thumbnailUrl={
          view && isImageMime(view.mime) ? attachmentHref(view) : undefined
        }
        status={status}
        progress={progress}
        errorText={
          state.status === 'error'
            ? describeUploadFailure(state.httpStatus, state.body)
            : state.status === 'canceled'
              ? 'Canceled.'
              : undefined
        }
        actions={
          <span className="flex gap-1">
            {retryable(state) ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => upload.retry(item.id)}
              >
                Retry
              </Button>
            ) : null}
            {state.status === 'queued' || state.status === 'uploading' ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => upload.cancel(item.id)}
              >
                Cancel
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => discard(item)}
              >
                Remove
              </Button>
            )}
          </span>
        }
      />
    </li>
  );
}

/**
 * A glass-ui dropzone (drop, picker, paste) with the queue of its uploads and
 * the "do not attach secrets" note (#309 D13). Uploads start at once; what is
 * done stays pending on the server until the parent claims it.
 */
export function AttachmentDropzone({
  uploads,
  label,
  disabled = false,
  pasteTarget = 'self',
  hideQueue = false,
}: {
  uploads: AttachmentUploads;
  /** The zone's accessible name. */
  label: string;
  disabled?: boolean;
  pasteTarget?: 'self' | 'none';
  /** The parent shows the finished rows itself (the card sheet claims them at once). */
  hideQueue?: boolean;
}) {
  const [refused, setRefused] = useState<string[]>([]);
  const items = hideQueue
    ? uploads.upload.items.filter((i) => i.state.status !== 'done')
    : uploads.upload.items;

  return (
    <div className="flex flex-col gap-2">
      <FileDropzone
        label={label}
        accept={ATTACHMENT_ACCEPT}
        maxSize={ATTACHMENT_MAX_BYTES}
        maxFiles={ATTACHMENTS_PER_CARD_MAX}
        disabled={disabled}
        pasteTarget={pasteTarget}
        className="p-4 text-center text-sm"
        onFiles={(files) => {
          setRefused([]);
          uploads.upload.add(files);
        }}
        onReject={(rejections: FileRejection[]) =>
          setRefused(rejections.map(describeRejection))
        }
      >
        <span className="font-medium">
          Drop files here, paste a screenshot, or click to choose
        </span>
        <span className="text-xs text-ink-2">
          Images, PDF and text files, up to 25 MiB each.
        </span>
      </FileDropzone>
      <p className="text-xs text-ink-3">{ATTACHMENT_NOTE}</p>
      {refused.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-1 text-xs text-danger">
          {refused.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      {items.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <UploadRow key={item.id} item={item} uploads={uploads} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
