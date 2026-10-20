'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { ChipButton } from '@andrewbehma/glass-ui/chip';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import type { BoardAskHit, BoardAskResponse } from '@nautelle/shared';
import { COLUMN_TITLE } from '@nautelle/shared';
import { Activity, GitPullRequest, SquareKanban, X } from 'lucide-react';
import Link from 'next/link';
import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import {
  type AskNotice,
  answerParts,
  askNotice,
  hitHref,
  queryChips,
  withoutChip,
} from '../../lib/board-ai/answer';
import { askBoard, searchBoard } from '../../lib/board-ai/client';

/** Closes the dialog when a link inside it leads to a page of the app. */
const LeaveContext = createContext<() => void>(() => {});

/**
 * #660 **Ask the Board**, opened from the command palette: the question is
 * turned into a query over the cards, pull requests and activity of the
 * projects the person can access, and answered in its own language. The
 * query is shown as chips; removing one runs the query again without a
 * model call, so the person can check what the question became.
 */
export function AskBoardDialog({
  question,
  onOpenChange,
}: {
  /** The question asked; null is closed. */
  question: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogRoot open={question !== null} onOpenChange={onOpenChange}>
      <DialogContent
        title="Ask the Board"
        description={question ?? undefined}
        className="flex flex-col sm:max-w-2xl max-lg:p-4"
      >
        <LeaveContext value={() => onOpenChange(false)}>
          {question !== null ? (
            <Answer key={question} question={question} />
          ) : null}
        </LeaveContext>
      </DialogContent>
    </DialogRoot>
  );
}

function Answer({ question }: { question: string }) {
  const [result, setResult] = useState<BoardAskResponse>();
  const [notice, setNotice] = useState<AskNotice>();
  const [narrowing, setNarrowing] = useState(false);
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    let live = true;
    askBoard(question).then(
      (answer) => live && setResult(answer),
      (error: unknown) => live && setNotice(askNotice(error)),
    );
    return () => {
      live = false;
    };
  }, [question]);

  if (notice) {
    return (
      <Banner
        tone={notice.tone === 'cap' ? 'warn' : 'danger'}
        title={notice.title}
      >
        {notice.text}
      </Banner>
    );
  }
  if (!result) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <span className="sr-only" role="status">
          Asking the Board
        </span>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-3 h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const removeChip = async (id: string) => {
    const query = withoutChip(result.query, id);
    setNarrowing(true);
    try {
      const { hits } = await searchBoard(query);
      setResult({ ...result, query, hits });
      setEdited(true);
    } catch (error) {
      setNotice(askNotice(error));
    } finally {
      setNarrowing(false);
    }
  };
  const chips = queryChips(result.query);

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <p className="text-sm leading-relaxed text-ink" lang={result.language}>
        {answerParts(result.answer, result.hits).map((part, i) =>
          part.type === 'text' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder.
            <span key={i}>{part.text}</span>
          ) : (
            <HitLink
              // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder.
              key={i}
              href={part.href}
              external={part.external}
              className="font-medium text-accent-ink underline-offset-2 hover:underline"
            >
              {part.text}
            </HitLink>
          ),
        )}
      </p>
      {edited ? (
        <p className="text-xs text-ink-3">
          The filters changed: the list below is up to date, the answer above is
          for the question as asked.
        </p>
      ) : null}

      {chips.length > 0 ? (
        <section
          aria-label="Read as"
          className="flex flex-wrap items-center gap-1.5"
        >
          <span className="text-xs text-ink-3">Read as</span>
          {chips.map((chip) => (
            <ChipButton
              key={chip.id}
              size="sm"
              disabled={narrowing}
              onClick={() => void removeChip(chip.id)}
              aria-label={`Remove ${chip.label}`}
              className="gap-1"
            >
              {chip.label}
              <X className="size-3" aria-hidden="true" />
            </ChipButton>
          ))}
        </section>
      ) : null}

      <section aria-label="Matches" className="flex min-h-0 flex-col">
        <h3 className="mb-1 text-xs font-medium text-ink-3">
          {result.hits.length === 0
            ? 'No matches'
            : `${result.hits.length} match${result.hits.length === 1 ? '' : 'es'}`}
        </h3>
        <ul className="-mx-2 flex max-h-80 flex-col overflow-y-auto">
          {result.hits.map((hit) => (
            <li key={hitKey(hit)}>
              <HitRow hit={hit} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const hitKey = (hit: BoardAskHit) =>
  hit.type === 'activity'
    ? `activity:${hit.id}`
    : `${hit.type}:${hit.projectId}:${hit.number}`;

function HitRow({ hit }: { hit: BoardAskHit }) {
  const target = hitHref(hit);
  const [Icon, label, meta] =
    hit.type === 'card'
      ? [
          SquareKanban,
          hit.label,
          [
            hit.projectName,
            COLUMN_TITLE[hit.column],
            hit.prNumber ? `PR #${hit.prNumber}` : null,
          ],
        ]
      : hit.type === 'pr'
        ? [
            GitPullRequest,
            `PR #${hit.number}`,
            [hit.projectName, hit.state, `C-${hit.cardNumber}`],
          ]
        : [
            Activity,
            new Date(hit.ts).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
            [hit.projectName],
          ];
  const body = (
    <>
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden="true" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-ink">
          <span className="mr-1.5 font-medium tabular-nums">{label}</span>
          {hit.title}
        </span>
        <span className="truncate text-xs text-ink-3">
          {meta.filter(Boolean).join(' · ')}
        </span>
      </span>
    </>
  );
  const row = 'flex gap-2.5 rounded-control px-2 py-2';
  return target ? (
    <HitLink
      href={target.href}
      external={target.external}
      className={`${row} hover:bg-hover focus-visible:bg-hover`}
    >
      {body}
    </HitLink>
  ) : (
    <div className={row}>{body}</div>
  );
}

function HitLink({
  href,
  external,
  className,
  children,
}: {
  href: string;
  external: boolean;
  className: string;
  children: ReactNode;
}) {
  const leave = use(LeaveContext);
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className} onClick={leave}>
      {children}
    </Link>
  );
}
