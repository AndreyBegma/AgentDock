import { Badge } from '@andrewbehma/glass-ui/badge';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';

export const DESCRIPTION_INCOMPLETE_HINT =
  'The worker finished after two rejections of its pull-request description: a required section or the summary is still missing. Review the description before you accept the card.';

/**
 * #445 D8: the artifact guard accepted the finish after two rewrites, with
 * `artifactIncomplete: true`. Renders nothing otherwise.
 */
export function DescriptionIncompleteBadge({
  incomplete,
}: {
  incomplete: boolean | undefined;
}) {
  if (!incomplete) return null;
  return (
    <Tooltip content={DESCRIPTION_INCOMPLETE_HINT}>
      <span className="inline-flex">
        <Badge tone="warn" size="md" label="Description incomplete" />
      </span>
    </Tooltip>
  );
}
