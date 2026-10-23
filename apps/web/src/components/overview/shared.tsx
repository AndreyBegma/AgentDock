import { Button } from '@andrewbehma/glass-ui/button';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import type { ProjectSummary } from '@nautelle/shared';
import type { Section as SectionState } from '../../lib/section/use-section';

export const notAnswering = (projects: ProjectSummary[]): string | undefined =>
  projects.length === 0
    ? undefined
    : projects.length === 1
      ? `${projects[0]?.displayName} is not answering`
      : `${projects.length} projects are not answering`;

export function Retry({
  title,
  section,
}: {
  title: string;
  section: Pick<SectionState<unknown>, 'retry' | 'loading'>;
}) {
  return (
    <SectionUnavailable
      title={title}
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
  );
}
