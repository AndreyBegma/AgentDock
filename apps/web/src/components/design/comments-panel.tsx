'use client';

import {
  DESIGN_COMMENT_MAX,
  type DesignCommentRequest,
  type DesignCommentView,
  type DesignOwnerView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { Textarea } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { useState } from 'react';
import {
  anchorLabel,
  groupComments,
  pinNumbers,
} from '../../lib/design/comments';
import { Time } from '../../lib/format/time';
import { type TextNotes, useTextNotes } from '../../lib/text/use-text-notes';
import { NormalizedNote } from '../text/normalized-note';

function CommentItem({
  comment,
  pinNumber,
  notes,
  canOperate,
}: {
  comment: DesignCommentView;
  pinNumber?: number;
  notes: TextNotes;
  canOperate: boolean;
}) {
  const anchor = anchorLabel(comment, pinNumber);
  return (
    <li className="flex flex-col gap-1 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
        <span className="font-medium text-ink-2">
          {comment.author?.name ?? 'Former member'}
        </span>
        <Time value={comment.createdAt} />
        {anchor ? <span>· {anchor}</span> : null}
      </div>
      <p className="text-sm whitespace-pre-wrap break-words">{comment.body}</p>
      <NormalizedNote
        view={notes.view('design_comment', comment.id, 'body')}
        canOperate={canOperate}
        onRetry={notes.retry}
      />
    </li>
  );
}

/**
 * The viewer's right panel, comments half (spec 223 "UI", D9, D10): open and
 * addressed, the revision in view by default; a general comment, or one on
 * the screen in view. Pins are left from the frame, not here.
 */
export function CommentsPanel({
  projectId,
  owner,
  canOperate = false,
  comments,
  revisionId,
  screen,
  writeBlock,
  busy,
  onComment,
}: {
  /** With `owner`: where the translation notes under each comment come from (#271). */
  projectId?: string;
  owner?: DesignOwnerView;
  /** Retry on a failed translation is for operators. */
  canOperate?: boolean;
  comments: readonly DesignCommentView[];
  /** The revision in view; null before the first one exists. */
  revisionId: string | null;
  /** The screen in view, for a `screen` comment. */
  screen: { viewport: string; theme: 'light' | 'dark' };
  /** Why the person cannot comment now, or null. */
  writeBlock: string | null;
  busy: boolean;
  onComment: (body: Omit<DesignCommentRequest, 'revisionId'>) => Promise<void>;
}) {
  const [allRevisions, setAllRevisions] = useState(false);
  const [showAddressed, setShowAddressed] = useState(false);
  const [body, setBody] = useState('');
  const [onScreen, setOnScreen] = useState(false);
  const notes = useTextNotes(
    projectId ?? '',
    projectId === undefined || owner === undefined
      ? null
      : owner.kind === 'card'
        ? { cardId: owner.cardId }
        : { planId: owner.planId },
    comments.length,
  );
  const { open, addressed } = groupComments(comments, revisionId, allRevisions);
  const numbers = pinNumbers(comments, revisionId);
  const text = body.trim();
  const screenLabel = `${screen.viewport} · ${screen.theme}`;

  const submit = async () => {
    if (!text) return;
    try {
      await onComment(
        onScreen
          ? { kind: 'screen', ...screen, body: text }
          : { kind: 'general', body: text },
      );
      setBody('');
    } catch {
      // Toasted by the caller; the text stays to try again.
    }
  };

  return (
    <section aria-label="Comments" className="flex flex-col gap-3">
      <SectionHeader
        title="Comments"
        description={
          open.length === 0
            ? 'No open comments.'
            : `${open.length} open — Revise design sends them all.`
        }
      />
      <Checkbox
        label="Comments of every revision"
        checked={allRevisions}
        onChange={(e) => setAllRevisions(e.target.checked)}
      />

      {open.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {open.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              pinNumber={numbers.get(c.id)}
              notes={notes}
              canOperate={canOperate}
            />
          ))}
        </ul>
      ) : null}

      {addressed.length > 0 ? (
        <Disclosure
          open={showAddressed}
          onOpenChange={setShowAddressed}
          trigger={`Addressed (${addressed.length})`}
        >
          <ul className="flex flex-col gap-2 pt-2">
            {addressed.map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                pinNumber={numbers.get(c.id)}
                notes={notes}
                canOperate={canOperate}
              />
            ))}
          </ul>
        </Disclosure>
      ) : null}

      {writeBlock ? (
        <p className="text-xs text-ink-3">{writeBlock}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="New comment"
            rows={3}
            maxLength={DESIGN_COMMENT_MAX}
            value={body}
            placeholder="A comment on the whole design. Use Pin for a point."
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Checkbox
              label={`Only this screen (${screenLabel})`}
              checked={onScreen}
              onChange={(e) => setOnScreen(e.target.checked)}
            />
            <Button
              size="sm"
              variant="glass"
              disabled={!text || busy || revisionId === null}
              onClick={() => void submit()}
            >
              {busy ? 'Saving…' : 'Comment'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
