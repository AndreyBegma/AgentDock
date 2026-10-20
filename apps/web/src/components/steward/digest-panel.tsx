'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import type {
  ProjectSummary,
  StewardDigestItem,
  StewardDigestView,
} from '@nautelle/shared';
import { useEffect } from 'react';
import { formatCost } from '../../lib/format';
import { Time } from '../../lib/format/time';
import { safeHttpsUrl } from '../../lib/queue/format';
import { useSection } from '../../lib/section/use-section';
import { fetchLatestDigest } from '../../lib/steward/actions';
import {
  DIGEST_TRIGGER_LABEL,
  digestCounts,
  digestIsQuiet,
} from '../../lib/steward/format';

/** A digest is a glance; look again every few minutes. */
const REFRESH_MS = 300_000;
/** Lines per bucket before "and n more" — the full list is in Telegram and Activity. */
const ITEMS_SHOWN = 4;

interface ProjectDigest {
  project: ProjectSummary;
  digest: StewardDigestView;
}

async function loadDigests(
  projects: ProjectSummary[],
): Promise<{ digests: ProjectDigest[]; failed: number }> {
  const results = await Promise.allSettled(
    projects.map(async (project) => ({
      project,
      digest: await fetchLatestDigest(project.id),
    })),
  );
  const digests: ProjectDigest[] = [];
  let failed = 0;
  for (const result of results) {
    if (result.status === 'rejected') failed += 1;
    else if (result.value.digest)
      digests.push({
        project: result.value.project,
        digest: result.value.digest,
      });
  }
  digests.sort((a, b) => b.digest.createdAt.localeCompare(a.digest.createdAt));
  return { digests, failed };
}

function Bucket({
  title,
  items,
}: {
  title: string;
  items: StewardDigestItem[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <h4 className="font-medium text-ink-2 text-xs">{title}</h4>
      <ul className="flex flex-col">
        {items.slice(0, ITEMS_SHOWN).map((item) => {
          const href = item.url ? safeHttpsUrl(item.url) : null;
          const body = (
            <>
              <span className="shrink-0 font-mono text-ink-3 text-xs">
                {item.label}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {item.title}
                {item.reason ? (
                  <span className="text-ink-3"> — {item.reason}</span>
                ) : null}
              </span>
            </>
          );
          return (
            <li key={`${item.label}-${item.title}`} className="text-sm">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-baseline gap-2 py-0.5 hover:underline"
                >
                  {body}
                </a>
              ) : (
                <span className="flex items-baseline gap-2 py-0.5">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > ITEMS_SHOWN ? (
        <p className="text-ink-3 text-xs">
          and {items.length - ITEMS_SHOWN} more
        </p>
      ) : null}
    </div>
  );
}

function DigestCard({ project, digest }: ProjectDigest) {
  return (
    <Card pad="md" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium text-sm">{project.displayName}</span>
        <span className="text-ink-3 text-xs">
          {DIGEST_TRIGGER_LABEL[digest.trigger]} ·{' '}
          <Time value={digest.createdAt} />
        </span>
      </div>
      {digest.prose ? (
        <p className="whitespace-pre-line text-sm text-ink-2">{digest.prose}</p>
      ) : null}
      <p className="num text-ink-2 text-xs">
        {digestCounts(digest)} · spent {formatCost(digest.spendUsd) || '$0'}
      </p>
      {digestIsQuiet(digest) ? (
        <p className="text-ink-3 text-sm">
          A quiet period — nothing to report.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Bucket title="Waiting on you" items={digest.waiting} />
          <Bucket title="Stuck" items={digest.stuck} />
          <Bucket title="Done" items={digest.done} />
        </div>
      )}
    </Card>
  );
}

/**
 * #447 D14: the latest Steward digest of each project on Overview. `prose` is
 * haiku's summary; when the runner was offline it is `null` and the digest is
 * the template's counts and lines. A project without a digest yet is left out.
 */
export function DigestPanel({ projects }: { projects: ProjectSummary[] }) {
  const ids = projects.map((p) => p.id).join(',');
  const section = useSection(() => loadDigests(projects), [ids]);
  const { retry } = section;
  useEffect(() => {
    const timer = setInterval(retry, REFRESH_MS);
    return () => clearInterval(timer);
  }, [retry]);

  return (
    <section aria-labelledby="overview-digest" className="flex flex-col gap-3">
      <SectionHeader title="Digest" headingId="overview-digest" />
      {section.data === undefined ? (
        section.error !== null ? (
          <SectionUnavailable
            title="Digests are not answering"
            action={
              <Button
                variant="glass"
                size="sm"
                onClick={retry}
                disabled={section.loading}
              >
                Try again
              </Button>
            }
          />
        ) : (
          <Skeleton className="h-24 w-full" />
        )
      ) : section.data.digests.length === 0 ? (
        <p className="text-ink-3 text-sm">
          {section.data.failed > 0
            ? 'Some projects did not answer, and the rest have no digest yet.'
            : 'No digest yet. Steward sends the first at the time set in the project’s Steward settings.'}
        </p>
      ) : (
        <>
          {section.data.failed > 0 ? (
            <p className="text-warn text-xs">
              {section.data.failed === 1
                ? 'One project did not answer; its digest is not shown.'
                : `${section.data.failed} projects did not answer; their digests are not shown.`}
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {section.data.digests.map(({ project, digest }) => (
              <DigestCard key={project.id} project={project} digest={digest} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
