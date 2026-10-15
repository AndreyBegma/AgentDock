'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import {
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { ChevronsUpDown, FolderGit2, List } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { RUNNER_STATUS_LABEL, STATUS_TONE } from '../../lib/runners/format';

function RunnerDot({ project }: { project: ProjectSummary }) {
  return (
    <Badge
      dot
      tone={STATUS_TONE[project.runnerStatus]}
      aria-hidden="true"
      className="shrink-0"
    />
  );
}

/**
 * Project switcher (spec 10 D3, #159): a button with the current project's
 * name, its runner's status and a chevron, opening the projects the caller may
 * see: at the head of the rail, and in More's sheet on a phone (#163).
 * Renders nothing while there are no projects; the Projects page still works.
 * `compact` (C-14, the collapsed rail): a square with the status dot alone,
 * the project's name in a tooltip.
 */
export function ProjectSwitcher({
  projects,
  projectId,
  compact = false,
}: {
  projects: readonly ProjectSummary[];
  projectId: string | null;
  compact?: boolean;
}) {
  const router = useRouter();
  if (projects.length === 0) return null;

  const current = projects.find((project) => project.id === projectId);
  const label = current
    ? `Switch project, current: ${current.displayName}, runner ${RUNNER_STATUS_LABEL[current.runnerStatus]}`
    : 'Choose a project';

  const status = current ? (
    <RunnerDot project={current} />
  ) : (
    <FolderGit2 size={16} aria-hidden="true" className="text-ink-3" />
  );

  const trigger = compact ? (
    <button
      type="button"
      aria-label={label}
      className={buttonClassName({
        variant: 'glass',
        size: 'md',
        full: true,
        className: 'justify-center px-0',
      })}
    >
      {status}
    </button>
  ) : (
    <button
      type="button"
      aria-label={label}
      className={buttonClassName({
        variant: 'glass',
        size: 'md',
        full: true,
        className: 'justify-between gap-2 px-3',
      })}
    >
      <span className="flex min-w-0 items-center gap-2">
        {status}
        <span className={`truncate ${current ? 'text-ink' : 'text-ink-2'}`}>
          {current?.displayName ?? 'Choose a project'}
        </span>
      </span>
      <ChevronsUpDown
        size={14}
        aria-hidden="true"
        className="shrink-0 text-ink-3"
      />
    </button>
  );

  return (
    <MenuRoot>
      {compact ? (
        <Tooltip
          content={current?.displayName ?? 'Choose a project'}
          side="right"
        >
          <MenuTrigger asChild>{trigger}</MenuTrigger>
        </Tooltip>
      ) : (
        <MenuTrigger asChild>{trigger}</MenuTrigger>
      )}
      <MenuContent align="start" className="max-h-[60vh] overflow-y-auto">
        <MenuLabel>Projects</MenuLabel>
        {projects.map((project) => (
          <MenuItem
            key={project.id}
            onSelect={() => router.push(`/projects/${project.id}`)}
            aria-current={project.id === projectId ? 'page' : undefined}
          >
            <RunnerDot project={project} />
            <span className="min-w-0 flex-1 truncate">
              {project.displayName}
            </span>
            <span className="sr-only">
              , runner {RUNNER_STATUS_LABEL[project.runnerStatus]}
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => router.push('/projects')}>
          <List size={16} aria-hidden="true" />
          All projects
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
