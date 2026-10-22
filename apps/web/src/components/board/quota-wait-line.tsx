import { Badge } from '@andrewbehma/glass-ui/badge';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { formatDate } from '../../lib/format';

/** A usage limit a session waits on, as the runner read it off the banner (#741). */
export interface QuotaWait {
  limit: string;
  /** ISO-8601; null when the banner showed no reset time that parses. */
  resetsAt: string | null;
}

const LIMIT_TEXT: Record<string, string> = {
  weekly: 'the weekly limit',
  session: 'the session limit',
  usage: 'the usage limit',
};

/** What the limit is, for a tooltip. */
export const quotaLimitText = (limit: string): string =>
  LIMIT_TEXT[limit] ?? 'a usage limit';

/** The line itself, with the reset time in the viewer's zone. */
export const quotaWaitText = (wait: QuotaWait): string =>
  wait.resetsAt
    ? `Waiting for the limit until ${formatDate(wait.resetsAt, 'datetime')}`
    : 'Limit reached';

/**
 * "Waiting for the limit until <time>" — the runner resumes the session by
 * itself a minute after that. Without a reset time it only says the limit was
 * reached: the runner will not resume it, a person has to.
 */
export function QuotaWaitLine({ wait }: { wait: QuotaWait }) {
  const tip = wait.resetsAt
    ? `The session hit ${quotaLimitText(wait.limit)}. Nautelle types “continue” a minute after it resets.`
    : `The session hit ${quotaLimitText(wait.limit)}. The banner shows no reset time, so it needs a person to continue it.`;
  return (
    <Tooltip content={tip}>
      <span>
        <Badge tone="warn" size="md" label={quotaWaitText(wait)} />
      </span>
    </Tooltip>
  );
}
