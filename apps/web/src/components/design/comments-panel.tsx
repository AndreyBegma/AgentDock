'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { Select, Textarea } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import {
  DESIGN_COMMENT_MAX,
  type DesignCommentRequest,
  type DesignCommentView,
  type DesignFrameView,
  type DesignOwnerView,
} from '@nautelle/shared';
import { PanelTop } from 'lucide-react';
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
  frameName,
  notes,
  canOperate,
  selected,
  onSelect,
}: {
  comment: DesignCommentView;
  pinNumber?: number;
  /** #441: the name of the frame it was left on. */
  frameName: string | null;
  notes: TextNotes;
  canOperate: boolean;
  selected: boolean;
  /** #886: open the comment where it was left — its tab, device and pin. */
  onSelect?: (comment: DesignCommentView) => void;
}) {
  const anchor = anchorLabel(comment, pinNumber);
  const content = (
    <>
      <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
        <span className="font-medium text-ink-2">
          {comment.author?.name ?? 'Former member'}
        </span>
        <Time value={comment.createdAt} />
        {anchor ? <span>· {anchor}</span> : null}
        {frameName ? (
          <Badge label={frameName} aria-label={`Frame: ${frameName}`} />
        ) : null}
      </span>
      <span className="block text-sm whitespace-pre-wrap break-words">
        {comment.body}
      </span>
    </>
  );
  return (
    <li
      className={`flex flex-col gap-1 rounded-md border p-3 ${
        selected ? 'border-accent' : 'border-line'
      }`}
    >
      {onSelect ? (
        <button
          type="button"
          aria-current={selected || undefined}
          title="Show where it was left"
          className="flex flex-col gap-1 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => onSelect(comment)}
        >
          {content}
        </button>
      ) : (
        <div className="flex flex-col gap-1">{content}</div>
      )}
      <NormalizedNote
        view={notes.view('design_comment', comment.id, 'body')}
        canOperate={canOperate}
        onRetry={notes.retry}
      />
    </li>
  );
}

type FrameScope = 'frame' | 'all';

/**
 * The viewer's right panel, comments half (spec 223 "UI", D9, D10): open and
 * addressed, the revision in view by default; a general comment, or one on
 * the screen in view. Pins are left from the frame, not here. #441: the
 * comments of the frame in view, or of all frames, each with its frame's
 * name; a new comment is written to the frame in view.
 */
export function CommentsPanel({
  projectId,
  owner,
  canOperate = false,
  comments,
  revisionId,
  frames = [],
  frame = 0,
  frameNameOf = () => null,
  screen,
  writeBlock,
  busy,
  onComment,
  selected = null,
  onSelect,
  devices = [],
  onDevice,
}: {
  /** With `owner`: where the translation notes under each comment come from (#271). */
  projectId?: string;
  owner?: DesignOwnerView;
  /** Retry on a failed translation is for operators. */
  canOperate?: boolean;
  comments: readonly DesignCommentView[];
  /** The revision in view; null before the first one exists. */
  revisionId: string | null;
  /** #441: the frames of the revision in view, and the one in view. */
  frames?: readonly DesignFrameView[];
  frame?: number;
  /** #441: the name of the frame a comment was left on, in its revision. */
  frameNameOf?: (comment: DesignCommentView) => string | null;
  /** The screen in view — #886: the device in view — for a `screen` comment. */
  screen: { viewport: string; theme: 'light' | 'dark' };
  /** Why the person cannot comment now, or null. */
  writeBlock: string | null;
  busy: boolean;
  onComment: (
    body: Omit<DesignCommentRequest, 'revisionId' | 'frame'>,
  ) => Promise<void>;
  /** #886: the comment shown on the canvas, by id. */
  selected?: string | null;
  onSelect?: (comment: DesignCommentView) => void;
  /** #886: the devices on the canvas, to pick the one a screen comment names. */
  devices?: readonly string[];
  onDevice?: (device: string) => void;
}) {
  const [allRevisions, setAllRevisions] = useState(false);
  const [scope, setScope] = useState<FrameScope>('frame');
  const [showAddressed, setShowAddressed] = useState(false);
  const [body, setBody] = useState('');
  const [onScreen, setOnScreen] = useState(false);
  const notes = useTextNotes(
    projectId ?? '',
    // #480: a stack's comments have no translation notes of their own yet.
    projectId === undefined || owner === undefined || owner.kind === 'stack'
      ? null
      : owner.kind === 'card'
        ? { cardId: owner.cardId }
        : { planId: owner.planId },
    comments.length,
  );
  // The frame filter reads positions of the revision in view only.
  const byFrame = scope === 'frame' && !allRevisions ? frame : null;
  const { open, addressed } = groupComments(
    comments,
    revisionId,
    allRevisions,
    byFrame,
  );
  const allOpen = groupComments(comments, revisionId, allRevisions).open;
  const frameName = frames[frame]?.name ?? null;
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
      {frames.length > 0 ? (
        <SegmentedControl size="sm" role="group" aria-label="Comment scope">
          {(['frame', 'all'] as const).map((s) => (
            <SegmentedControlItem
              key={s}
              active={scope === s}
              layoutId="design-comment-scope"
            >
              <button
                type="button"
                aria-pressed={scope === s}
                className="px-2 py-1 text-xs whitespace-nowrap"
                onClick={() => setScope(s)}
              >
                {s === 'frame'
                  ? 'This frame'
                  : `All frames (${allOpen.length})`}
              </button>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      ) : null}
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
              frameName={frameNameOf(c)}
              notes={notes}
              canOperate={canOperate}
              selected={c.id === selected}
              onSelect={onSelect}
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
                frameName={frameNameOf(c)}
                notes={notes}
                canOperate={canOperate}
                selected={c.id === selected}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </Disclosure>
      ) : null}

      {writeBlock ? (
        <p className="text-xs text-ink-3">{writeBlock}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {frameName ? (
            <p className="flex items-center gap-1 text-xs text-ink-3">
              <PanelTop aria-hidden="true" className="size-3.5" />
              Commenting on{' '}
              <span className="font-semibold text-ink">{frameName}</span>
            </p>
          ) : null}
          <Textarea
            aria-label="New comment"
            rows={3}
            maxLength={DESIGN_COMMENT_MAX}
            value={body}
            placeholder={
              frames.length > 1
                ? 'What should change in this frame? Use Pin for a point.'
                : 'A comment on the whole design. Use Pin for a point.'
            }
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                label={`Only this screen (${screenLabel})`}
                checked={onScreen}
                onChange={(e) => setOnScreen(e.target.checked)}
              />
              {onScreen && onDevice && devices.length > 1 ? (
                <Select
                  aria-label="Device"
                  className="h-8 w-auto text-xs"
                  value={screen.viewport}
                  onChange={(e) => onDevice(e.target.value)}
                >
                  {devices.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
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
