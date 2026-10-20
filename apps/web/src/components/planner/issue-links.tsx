import type { PlanTaskIssueView } from '@nautelle/shared';
import { ExternalLink } from 'lucide-react';

/** A sent task's issue and pull request, as links out to GitHub. */
export function IssueLinks({
  issue,
  className = '',
}: {
  issue: PlanTaskIssueView;
  className?: string;
}) {
  const link =
    'inline-flex items-center gap-1 text-xs text-accent-ink underline underline-offset-2';
  return (
    <span className={`flex flex-wrap items-center gap-3 ${className}`}>
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer noopener"
        className={link}
      >
        Issue #{issue.number}
        <ExternalLink aria-hidden="true" className="size-3" />
      </a>
      {issue.prUrl && issue.prNumber !== null ? (
        <a
          href={issue.prUrl}
          target="_blank"
          rel="noreferrer noopener"
          className={link}
        >
          PR #{issue.prNumber}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      ) : null}
    </span>
  );
}
