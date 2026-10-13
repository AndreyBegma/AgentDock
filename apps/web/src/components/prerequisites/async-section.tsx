'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import type { ReactNode } from 'react';
import { sectionView } from '../../lib/section/state';
import type { Section } from '../../lib/section/use-section';

/**
 * Rule R2 for one section: a `Skeleton` while the first load runs,
 * `SectionUnavailable` with Try again when it fails (above the data it still
 * has, if any), the caller's `EmptyState` when there is nothing, else the data.
 */
export function AsyncSection<T>({
  section,
  unavailable,
  empty,
  isEmpty,
  skeleton = <Skeleton className="h-32 w-full" />,
  children,
}: {
  section: Section<T>;
  /** "Sessions are not answering", and what still works. */
  unavailable: { title: string; stillWorks?: string };
  /** An `EmptyState` with an `action` (rule R3). */
  empty: ReactNode;
  isEmpty?: (data: T) => boolean;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const view = sectionView(section, isEmpty);
  if (view === 'loading') return skeleton;

  const failure =
    section.error !== null ? (
      <SectionUnavailable
        title={unavailable.title}
        stillWorks={unavailable.stillWorks}
        action={
          <Button
            variant="glass"
            size="sm"
            onClick={section.retry}
            disabled={section.loading}
          >
            Try again
          </Button>
        }
      />
    ) : null;
  if (view === 'unavailable') return failure;

  return (
    <div className="flex flex-col gap-3">
      {failure}
      {view === 'empty' || section.data === undefined
        ? empty
        : children(section.data)}
    </div>
  );
}
