'use client';

import { Card } from '@andrewbehma/glass-ui/card';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import type { AiDigestItem, AiDigestView } from '@nautelle/shared';
import Link from 'next/link';
import { fetchLatestAiDigest } from '../../lib/ai/actions';
import { Time } from '../../lib/format/time';
import { safeHttpsUrl } from '../../lib/queue/format';
import { useSection } from '../../lib/section/use-section';

/** Lines per section before "and n more" — the full list is in Telegram. */
const ITEMS_SHOWN = 5;

interface DigestProject {
  id: string;
  displayName: string;
}

interface ProjectDigest {
  project: DigestProject;
  digest: AiDigestView;
}

async function loadDigests(
  projects: DigestProject[],
): Promise<ProjectDigest[]> {
  const results = await Promise.allSettled(
    projects.map(async (project) => ({
      project,
      digest: await fetchLatestAiDigest(project.id),
    })),
  );
  const digests: ProjectDigest[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.digest) {
      digests.push({
        project: result.value.project,
        digest: result.value.digest,
      });
    }
  }
  return digests.sort((a, b) =>
    b.digest.createdAt.localeCompare(a.digest.createdAt),
  );
}

function Section({ title, items }: { title: string; items: AiDigestItem[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h4 className="font-medium text-ink-2 text-xs">
        {title} <span className="num text-ink-3">{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="text-ink-3 text-sm">Nothing.</p>
      ) : (
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
              <li
                key={`${item.label}-${item.reason ?? ''}`}
                className="text-sm"
              >
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
                  <span className="flex items-baseline gap-2 py-0.5">
                    {body}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {items.length > ITEMS_SHOWN ? (
        <p className="text-ink-3 text-xs">
          and {items.length - ITEMS_SHOWN} more
        </p>
      ) : null}
    </div>
  );
}

function DigestCard({
  project,
  digest,
  showProject,
}: ProjectDigest & { showProject: boolean }) {
  return (
    <Card pad="md" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium text-sm">
          {showProject ? `${project.displayName} · ` : ''}Daily digest
        </span>
        <span className="text-ink-3 text-xs">
          <Time value={digest.createdAt} /> · {digest.model}
        </span>
      </div>
      <p className="text-sm text-ink-2">{digest.overview}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Section title="Done" items={digest.done} />
        <Section title="Stuck" items={digest.stuck} />
        <Section title="Waiting for you" items={digest.waiting} />
      </div>
    </Card>
  );
}

/**
 * #658: the latest daily AI digest above the activity feed — one project's on
 * its activity page, each project's on the whole feed. A project without a
 * digest is left out; on its own page it says how to turn one on.
 */
export function AiDigestPanel({
  projects,
  single = false,
}: {
  projects: DigestProject[];
  /** One project's activity page: no project names, and a hint when empty. */
  single?: boolean;
}) {
  const ids = projects.map((p) => p.id).join(',');
  const section = useSection(() => loadDigests(projects), [ids]);

  if (section.data === undefined) {
    return section.error !== null ? null : (
      <Skeleton className="mb-4 h-28 w-full" />
    );
  }
  if (section.data.length === 0) {
    return single && projects[0] ? (
      <p className="mb-4 text-ink-3 text-sm">
        No AI digest yet. A project admin turns it on in{' '}
        <Link
          href={`/projects/${projects[0].id}/settings?tab=ai-digest`}
          className="text-accent-ink underline underline-offset-2"
        >
          Settings › AI digest
        </Link>
        .
      </p>
    ) : null;
  }
  return (
    <section aria-labelledby="ai-digest" className="mb-6 flex flex-col gap-3">
      <SectionHeader title="Digest" headingId="ai-digest" />
      {section.data.map(({ project, digest }) => (
        <DigestCard
          key={project.id}
          project={project}
          digest={digest}
          showProject={!single}
        />
      ))}
    </section>
  );
}
