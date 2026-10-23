'use client';

import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { projectRoleAtLeast } from '@nautelle/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { CardNotFound } from '../../../../../../../components/board/card-not-found';
import type { TerminalAccess } from '../../../../../../../components/board/card-sheet';
import { CardDetailBody } from '../../../../../../../components/board/card-sheet';
import { useCardTab } from '../../../../../../../components/board/card-tabs';
import { useCardActions } from '../../../../../../../components/board/use-card-actions';
import { fetchCard } from '../../../../../../../lib/board/actions';
import {
  describeBoardError,
  isNotFound,
} from '../../../../../../../lib/board/format';
import { boardHref } from '../../../../../../../lib/board/href';
import { useSection } from '../../../../../../../lib/section/use-section';
import { useTerminalAvailable } from '../../../../../../../lib/terminal/use-terminal-available';
import { useProjectDetail } from '../../../use-project-detail';

/**
 * #431: one Board card on its own page. The same `CardDetailBody` as the
 * sheet, laid out in the compact header and tabs at full width.
 */
export default function CardPage() {
  const params = useParams<{ projectId: string; number: string }>();
  const { projectId } = params;
  const number = Number(params.number);
  const router = useRouter();
  const [tab, setTab] = useCardTab(`${projectId}:${number}`);

  const project = useProjectDetail(projectId).data;
  const role = project?.role ?? 'viewer';
  const canOperate = projectRoleAtLeast(role, 'operator');
  const isAdmin = role === 'admin';
  const canAttach = useTerminalAvailable(project?.runnerId, isAdmin);
  const validNumber = Number.isInteger(number) && number >= 1;
  const card = useSection(
    () => fetchCard(projectId, number),
    [projectId, number],
  );
  const actions = useCardActions({
    projectId,
    runnerName: project?.runnerName,
    runnerCommands: project?.runnerCommands,
    onChanged: card.retry,
    onDeleted: () => router.push(boardHref(projectId)),
  });
  const terminal: TerminalAccess = {
    state: 'disabled',
    reason: canAttach
      ? 'Open the terminal from the board.'
      : isAdmin
        ? 'The runner does not offer terminal attach.'
        : 'Only administrators can open a terminal.',
  };

  const back = (
    <Link
      href={boardHref(projectId)}
      className={buttonClassName({ variant: 'ghost', size: 'sm' })}
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Back to the board
    </Link>
  );

  if (!validNumber || isNotFound(card.error)) {
    return (
      <div className="flex flex-col gap-3">
        <div>{back}</div>
        <CardNotFound projectId={projectId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div>{back}</div>
      {card.data ? (
        <CardDetailBody
          // A new round resets the form; a refetch mid-typing does not.
          key={`${card.data.id}:${card.data.rounds.length}`}
          layout="page"
          sheetTitle={`${card.data.label} ${card.data.title}`}
          projectId={projectId}
          card={card.data}
          canOperate={canOperate}
          actions={actions}
          terminal={terminal}
          runnerName={project?.runnerName}
          onSaved={card.retry}
          tab={tab}
          onTabChange={setTab}
        />
      ) : card.error ? (
        <p role="alert" className="text-sm text-danger">
          {describeBoardError(card.error)}
        </p>
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
      {actions.dialogs}
    </div>
  );
}
