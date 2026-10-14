'use client';

import type { SessionContentItem, SessionContentPage } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Time } from '../../lib/format/time';
import { useErrorToast } from '../../lib/section/use-error-toast';
import {
  contentPath,
  contentTitle,
  describeContentError,
} from '../../lib/sessions/content';

/** Longest a row's text box grows before it scrolls. */
const TEXT_MAX_HEIGHT = 240;

function ContentRow({ item }: { item: SessionContentItem }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg surface-content p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{contentTitle(item)}</span>
        {item.truncated ? <Badge tone="warn" label="Truncated" /> : null}
        <span className="ml-auto text-xs text-ink-3">
          <Time value={item.at} format="time" />
        </span>
      </div>
      {/* Text only: the content is redacted by pattern, never trusted as markup. */}
      <CodeBlock code={item.text} wrap maxHeight={TEXT_MAX_HEIGHT} copy />
    </li>
  );
}

/**
 * What the session said and did, from its hooks (ADR-0021): prompt, tool
 * input and output, response. The caller only mounts it for an operator of a
 * project whose session has content. `refreshKey` changes when the session
 * does, which reloads the first page.
 */
export function SessionContentTimeline({
  projectId,
  sessionId,
  refreshKey,
}: {
  projectId: string;
  sessionId: string;
  refreshKey: string;
}) {
  const [items, setItems] = useState<SessionContentItem[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const showError = useErrorToast();
  // Only the newest first-page request may write.
  const generation = useRef(0);

  const loadFirst = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const page = await api<SessionContentPage>(
        contentPath(projectId, sessionId),
      );
      if (mine !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setFailure(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setFailure(err);
    }
  }, [projectId, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the reload trigger
  useEffect(() => {
    loadFirst();
  }, [loadFirst, refreshKey]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<SessionContentPage>(
        contentPath(projectId, sessionId, nextCursor),
      );
      setItems((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      showError(describeContentError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="mt-6 flex flex-col gap-3" aria-label="Session content">
      <SectionHeader
        title="Content"
        description="Prompts, tool calls and responses reported by the session's hooks. Redaction is pattern-based and can miss a secret."
      />
      {failure !== null ? (
        <SectionUnavailable
          title="Content could not be loaded"
          stillWorks={`${describeContentError(failure)} The trace above is unaffected.`}
          action={
            <Button variant="glass" size="sm" onClick={() => void loadFirst()}>
              Try again
            </Button>
          }
        />
      ) : null}
      {items === undefined ? (
        failure === null ? (
          <Skeleton className="h-24 w-full" />
        ) : null
      ) : items.length === 0 ? (
        <EmptyState
          title="No content stored"
          description="Nothing has been kept for this session, or it has passed the project's retention."
        />
      ) : (
        <>
          <ol className="flex flex-col gap-2">
            {items.map((item) => (
              <ContentRow key={item.id} item={item} />
            ))}
          </ol>
          {nextCursor ? (
            <div className="flex justify-center">
              <Button variant="glass" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
