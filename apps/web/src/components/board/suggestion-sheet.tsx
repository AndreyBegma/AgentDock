'use client';

import {
  type AcceptSuggestionRequest,
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_KINDS,
  BOARD_CARD_TITLE_MAX,
  type BoardCardDetail,
  type BoardCardKind,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Input, Select, Textarea } from '@andrewbehma/glass-ui/field';
import Link from 'next/link';
import { useState } from 'react';
import { confidenceLabel, sessionHref } from '../../lib/board/format';
import type { CardActions } from './use-card-actions';

const KIND_LABEL: Record<BoardCardKind, string> = {
  feature: 'Feature',
  bug: 'Bug',
};

/**
 * #244 D8/D9: the sheet of an Inbox card — why capture suggested it, the
 * evidence (operators only; Accept strips it), and a form to edit the card
 * on its way to To Do.
 */
export function SuggestionSheetBody({
  card,
  canOperate,
  actions,
  onDone,
}: {
  card: BoardCardDetail;
  canOperate: boolean;
  actions: CardActions;
  /** The card left the Inbox: close the sheet. */
  onDone: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [kind, setKind] = useState(card.kind);
  const confidence = confidenceLabel(card.captureConfidence);
  const session = sessionHref(card.sourceSessionId);

  const edits: AcceptSuggestionRequest = {
    ...(title.trim() !== card.title ? { title: title.trim() } : {}),
    ...(body !== card.body ? { body } : {}),
    ...(kind !== card.kind ? { kind } : {}),
  };
  const edited = Object.keys(edits).length > 0;

  const accept = async () => {
    if (await actions.acceptSuggestion(card, edited ? edits : undefined)) {
      onDone();
    }
  };

  const dismiss = async () => {
    if (await actions.dismiss(card)) onDone();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="warn" label="Suggested" />
        {confidence ? (
          <span className="tabular-nums text-ink-2">{confidence} sure</span>
        ) : null}
        {session ? (
          <Link
            href={session}
            className="ml-auto text-accent-ink underline-offset-2 hover:underline"
          >
            Source session
          </Link>
        ) : null}
      </div>
      {card.captureWhy ? (
        <section aria-label="Why" className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Why it was suggested</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-ink-2">
            {card.captureWhy}
          </p>
        </section>
      ) : null}

      {card.evidence && card.evidence.length > 0 ? (
        <section aria-label="Evidence" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Evidence</h3>
          <p className="text-xs text-ink-3">
            What the model read. It is dropped when you accept the card.
          </p>
          <ul className="flex flex-col gap-2">
            {card.evidence.map((item) => (
              <li
                key={item.contentId}
                className="rounded-control bg-surface p-3 text-sm"
              >
                <span className="text-xs text-ink-3">
                  {item.kind === 'prompt' ? 'You asked' : 'Claude answered'}
                </span>
                <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">
                  {item.excerpt}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canOperate && title.trim() !== '' && !actions.busy) {
            void accept();
          }
        }}
      >
        <h3 className="text-sm font-medium">Edit & accept</h3>
        <Field label="Title" htmlFor="inbox-card-title">
          <Input
            id="inbox-card-title"
            value={title}
            maxLength={BOARD_CARD_TITLE_MAX}
            disabled={!canOperate}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="What to do" htmlFor="inbox-card-body">
          <Textarea
            id="inbox-card-body"
            rows={8}
            value={body}
            maxLength={BOARD_CARD_BODY_MAX}
            disabled={!canOperate}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <Field label="Kind" htmlFor="inbox-card-kind">
          <Select
            id="inbox-card-kind"
            value={kind}
            disabled={!canOperate}
            onChange={(e) =>
              setKind(
                BOARD_CARD_KINDS.find((k) => k === e.target.value) ?? kind,
              )
            }
          >
            {BOARD_CARD_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        {canOperate ? (
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              disabled={actions.busy}
              onClick={() => void dismiss()}
            >
              Dismiss
            </Button>
            <Button
              variant="solid"
              type="submit"
              disabled={actions.busy || title.trim() === ''}
            >
              {edited ? 'Accept with edits' : 'Accept'}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
