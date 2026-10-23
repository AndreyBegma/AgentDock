import { Button } from '@andrewbehma/glass-ui/button';
import { Textarea } from '@andrewbehma/glass-ui/field';
import { SheetContent } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { REVIEW_INSTRUCTIONS_MAX } from '@nautelle/shared';
import { Markdown } from '../markdown/markdown';

/**
 * The Peer review instructions: Markdown in a textarea with a preview, Save,
 * and Regenerate (which the tab puts behind a confirmation). A sheet from the
 * side on desktop; on a phone it fills the screen. Must sit in a `SheetRoot`.
 */
export function PeerReviewEditor({
  value,
  saved,
  phone,
  readOnly,
  generating,
  saving,
  error,
  onChange,
  onSave,
  onRegenerate,
}: {
  value: string;
  /** What is stored now; Save is off while `value` equals it. */
  saved: string;
  phone: boolean;
  readOnly: boolean;
  /** Regenerate is running: the text is replaced when it finishes. */
  generating: boolean;
  saving: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onSave: () => void;
  onRegenerate: () => void;
}) {
  const dirty = value !== saved;
  return (
    <SheetContent
      side={phone ? 'bottom' : 'right'}
      title="Peer review instructions"
      description="What the reviewer is told to look for. Markdown."
      className={phone ? 'h-dvh max-h-none rounded-none' : undefined}
      footer={
        readOnly ? null : (
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="glass"
              disabled={generating || saving}
              onClick={onRegenerate}
            >
              Regenerate
            </Button>
            <Button
              variant="solid"
              disabled={!dirty || generating || saving}
              onClick={onSave}
            >
              Save
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {generating ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="text-ink-2 text-sm">
              Generating new instructions from the repository. This can take a
              minute.
            </p>
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <Textarea
            aria-label="Peer review instructions"
            rows={phone ? 18 : 16}
            maxLength={REVIEW_INSTRUCTIONS_MAX}
            readOnly={readOnly}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        {error ? (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        ) : null}
        {!generating && value.trim() ? (
          <div className="flex flex-col gap-2">
            <h3 className="font-medium text-ink-2 text-xs uppercase">
              Preview
            </h3>
            <Markdown>{value}</Markdown>
          </div>
        ) : null}
      </div>
    </SheetContent>
  );
}
