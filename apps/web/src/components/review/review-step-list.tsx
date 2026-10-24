import type { ReviewStepView } from '@nautelle/shared';
import { ReviewStepRow, type ReviewStepRowProps } from './review-step-row';

type RowHandlers = Pick<
  ReviewStepRowProps,
  'onToggle' | 'onEdit' | 'onRegenerate' | 'onDelete'
>;

/** The ordered steps; `onMove(stepId, to)` is both the arrows' and the drop's. */
export function ReviewStepList({
  steps,
  disabled,
  busy,
  dragging,
  onDragStart,
  onMove,
  onToggle,
  onEdit,
  onRegenerate,
  onDelete,
}: {
  steps: readonly ReviewStepView[];
  disabled: boolean;
  busy: boolean;
  /** The step being dragged, if any. */
  dragging: string | null;
  onDragStart: (stepId: string) => void;
  onMove: (stepId: string, to: number) => void;
  onToggle: (step: ReviewStepView, enabled: boolean) => void;
  onEdit: (step: ReviewStepView) => void;
  onRegenerate: (step: ReviewStepView) => void;
  onDelete: (step: ReviewStepView) => void;
}) {
  const handlers = (step: ReviewStepView): RowHandlers => ({
    onToggle: (enabled) => onToggle(step, enabled),
    onEdit: () => onEdit(step),
    onRegenerate: () => onRegenerate(step),
    onDelete: () => onDelete(step),
  });
  return (
    <ol aria-label="Review steps" className="flex flex-col">
      {steps.map((step, index) => (
        <ReviewStepRow
          key={step.id}
          step={step}
          index={index}
          count={steps.length}
          disabled={disabled}
          busy={busy}
          onMove={(to) => onMove(step.id, to)}
          onDragStart={() => onDragStart(step.id)}
          onDrop={() => {
            if (dragging && dragging !== step.id) onMove(dragging, index);
          }}
          {...handlers(step)}
        />
      ))}
    </ol>
  );
}
