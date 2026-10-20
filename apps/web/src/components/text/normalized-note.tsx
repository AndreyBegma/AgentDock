'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@andrewbehma/glass-ui/popover';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import type { TextFieldView } from '@nautelle/shared';
import { useState } from 'react';
import { describeBoardError } from '../../lib/board/format';
import { noteModel } from '../../lib/text/note';

/**
 * The small line under a text that people typed in any language and Nautelle
 * stores in English (#271): translating, "Show original", or "Not normalized".
 * Renders nothing for text that was English or never requested.
 */
export function NormalizedNote({
  view,
  canOperate,
  onRetry,
}: {
  view: TextFieldView | undefined;
  /** Retry is for operators. */
  canOperate: boolean;
  onRetry: (normalizationId: string) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const note = noteModel(view, canOperate);
  if (note.kind === 'none') return null;

  if (note.kind === 'normalizing') {
    return (
      <p className="flex items-center gap-2 text-xs text-ink-3">
        <Spinner size="sm" label="Translating to English…" />
        Translating to English…
      </p>
    );
  }

  if (note.kind === 'original') {
    return (
      <PopoverRoot>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="self-start"
          >
            Show original
          </Button>
        </PopoverTrigger>
        <PopoverContent
          title="Original text"
          align="start"
          className="w-96 max-w-[calc(100vw-2rem)]"
        >
          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm">
            {note.original}
          </p>
        </PopoverContent>
      </PopoverRoot>
    );
  }

  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry(note.normalizationId);
    } catch (err) {
      toast.error(describeBoardError(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <p className="flex flex-wrap items-center gap-2">
      <Tooltip content={note.reason}>
        <span className="inline-flex">
          <Badge tone="warn" label="Not normalized" />
        </span>
      </Tooltip>
      {note.canRetry ? (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={retrying}
          onClick={() => void retry()}
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      ) : null}
    </p>
  );
}
