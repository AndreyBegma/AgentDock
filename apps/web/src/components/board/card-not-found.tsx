import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import Link from 'next/link';
import { boardHref } from '../../lib/board/href';

/** #431: the card page for a number that is not a card of this project. */
export function CardNotFound({ projectId }: { projectId: string }) {
  return (
    <EmptyState
      title="Card not found"
      description="It was removed, or you are not a member of its project."
      action={
        <Link
          href={boardHref(projectId)}
          className={buttonClassName({ variant: 'glass' })}
        >
          Back to the board
        </Link>
      }
    />
  );
}
