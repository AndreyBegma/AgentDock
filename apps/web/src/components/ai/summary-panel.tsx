'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import type { AiSummaryView } from '@nautelle/shared';
import { useState } from 'react';
import type { SummaryNotice } from '../../lib/ai/format';
import { summaryMeta, summaryNotice } from '../../lib/ai/format';
import { Time } from '../../lib/format/time';

type State =
  | { phase: 'idle' }
  | { phase: 'loading'; regenerate: boolean }
  | { phase: 'done'; summary: AiSummaryView }
  | { phase: 'failed'; notice: SummaryNotice };

/**
 * #658: a one-click summary. Summarize asks once; a repeat with nothing
 * changed is served from the API's cache (no new call). Regenerate makes it
 * again. A reached cap shows as the cap message instead of a summary.
 * Give it a `key` per subject, so a different card or session starts over.
 */
export function SummaryPanel({
  title,
  headingId,
  hint,
  summarize,
}: {
  title: string;
  headingId: string;
  /** What it summarizes, before the first click. */
  hint: string;
  summarize: (regenerate: boolean) => Promise<AiSummaryView>;
}) {
  const [state, setState] = useState<State>({ phase: 'idle' });

  const run = async (regenerate: boolean) => {
    setState({ phase: 'loading', regenerate });
    try {
      setState({ phase: 'done', summary: await summarize(regenerate) });
    } catch (err) {
      setState({ phase: 'failed', notice: summaryNotice(err) });
    }
  };

  const busy = state.phase === 'loading';
  const done = state.phase === 'done';

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <SectionHeader
        title={title}
        headingId={headingId}
        headingLevel={3}
        actions={
          <Button
            variant="glass"
            size="sm"
            disabled={busy}
            onClick={() => void run(done)}
          >
            {busy ? 'Summarizing…' : done ? 'Regenerate' : 'Summarize'}
          </Button>
        }
      />
      {state.phase === 'idle' ? (
        <p className="text-ink-3 text-xs">{hint}</p>
      ) : null}
      {state.phase === 'loading' ? (
        <div className="flex flex-col gap-1.5" aria-busy="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : null}
      {state.phase === 'done' ? (
        <div className="flex flex-col gap-1">
          <p className="whitespace-pre-line text-sm">{state.summary.text}</p>
          <p className="num text-ink-3 text-xs">
            {summaryMeta(state.summary)} ·{' '}
            <Time value={state.summary.createdAt} />
          </p>
        </div>
      ) : null}
      {state.phase === 'failed' ? (
        <Banner
          tone={state.notice.tone === 'cap' ? 'warn' : 'danger'}
          title={
            state.notice.tone === 'cap'
              ? 'Monthly AI cap reached'
              : 'Could not summarize'
          }
        >
          {state.notice.text}
        </Banner>
      ) : null}
    </section>
  );
}
