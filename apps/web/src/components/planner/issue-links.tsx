import type { PlanTaskIssueView } from '@nautelle/shared';
import { ExternalLink } from 'lucide-react';
import { githubUrl } from '../../lib/url';

/**
 * A sent task's issue and pull request, as links out to GitHub. A URL that is
 * not `https://github.com/…` is shown as text, never followed.
 */
export function IssueLinks({
  issue,
  className = '',
}: {
  issue: PlanTaskIssueView;
  className?: string;
}) {
  const link =
    'inline-flex items-center gap-1 text-xs text-accent-ink underline underline-offset-2';
  const issueHref = githubUrl(issue.url);
  const prHref = githubUrl(issue.prUrl);
  return (
    <span className={`flex flex-wrap items-center gap-3 ${className}`}>
      {issueHref ? (
        <a
          href={issueHref}
          target="_blank"
          rel="noreferrer noopener"
          className={link}
        >
          Issue #{issue.number}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      ) : (
        <span className="text-xs">Issue #{issue.number}</span>
      )}
      {issue.prNumber !== null ? (
        prHref ? (
          <a
            href={prHref}
            target="_blank"
            rel="noreferrer noopener"
            className={link}
          >
            PR #{issue.prNumber}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        ) : issue.prUrl ? (
          <span className="text-xs">PR #{issue.prNumber}</span>
        ) : null
      ) : null}
    </span>
  );
}
