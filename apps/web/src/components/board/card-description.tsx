import { Button } from '@andrewbehma/glass-ui/button';
import { Textarea } from '@andrewbehma/glass-ui/field';
import { BOARD_CARD_BODY_MAX } from '@nautelle/shared';
import { Markdown } from '../markdown/markdown';

/**
 * #431: a card's "What to do". Rendered as Markdown by default; Edit swaps in
 * the textarea (Preview swaps back). A viewer only ever sees it rendered.
 */
export function CardDescription({
  body,
  editing,
  canOperate,
  rows,
  onChange,
  onToggle,
}: {
  body: string;
  editing: boolean;
  canOperate: boolean;
  rows: number;
  onChange: (body: string) => void;
  onToggle: () => void;
}) {
  return (
    <>
      {editing && canOperate ? (
        <Textarea
          id="board-card-body"
          rows={rows}
          value={body}
          maxLength={BOARD_CARD_BODY_MAX}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div
          data-testid="card-body-rendered"
          className="rounded-control bg-surface p-3"
        >
          <Markdown>{body || '*Nothing written yet.*'}</Markdown>
        </div>
      )}
      {canOperate ? (
        <div className="mt-2">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            aria-pressed={editing}
            onClick={onToggle}
          >
            {editing ? 'Preview' : 'Edit'}
          </Button>
        </div>
      ) : null}
    </>
  );
}
