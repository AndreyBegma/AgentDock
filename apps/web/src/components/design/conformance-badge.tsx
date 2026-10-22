'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import type { DesignConformance } from '@nautelle/shared';
import { conformanceNote } from '../../lib/design/templates';

/**
 * #833 D7, D11, D12: the "Not per template" badge of a revision whose frames
 * do not follow its template — what is missing, extra or out of order, with
 * **Complete** to start the repair turn by hand. A legacy revision has no
 * conformance and shows nothing.
 */
export function ConformanceBadge({
  conformance,
  canComplete,
  completing,
  disabledReason,
  onComplete,
}: {
  conformance: DesignConformance | null;
  canComplete: boolean;
  completing: boolean;
  /** Why Complete is off right now (a turn running, no write access); null when it is on. */
  disabledReason: string | null;
  onComplete: () => void;
}) {
  const note = conformanceNote(conformance);
  if (!note) return null;
  return (
    <section
      aria-label="Not per template"
      className="flex flex-col gap-2 rounded-md border border-line p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone="warn" label="Not per template" />
        {canComplete ? (
          <Button
            size="sm"
            variant="glass"
            disabled={completing || disabledReason !== null}
            title={disabledReason ?? undefined}
            onClick={onComplete}
          >
            {completing ? 'Starting…' : 'Complete'}
          </Button>
        ) : null}
      </div>
      {note.lines.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {note.lines.map((line) => (
            <li key={line.label}>
              <span className="text-ink-3">{line.label}: </span>
              <span className="font-mono">{line.items.join(', ')}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {note.tooManySteps ? (
        <p className="text-xs text-ink-2">
          The flow needs more steps than the template allows, so only the first
          ones are drawn. Consider splitting the card into a stack.
        </p>
      ) : null}
    </section>
  );
}
