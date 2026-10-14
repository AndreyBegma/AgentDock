'use client';

import type { SlotWorktreeView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  formatAgo,
  formatAheadBehind,
} from '../../../../../../lib/fleet/format';
import { formatDate, pluralize } from '../../../../../../lib/format';
import type { Section } from '../../../../../../lib/section/use-section';
import {
  describeWorktreeError,
  FILE_STATUS_LABEL,
  FILE_STATUS_MARK,
  formatLineCounts,
  shortSha,
} from '../../../../../../lib/slot/format';

const CHANGE_BRANCH_REASON =
  'The orchestrator owns the slot’s branch: it created it with the worktree and merges it. Ask it in the chat instead.';

/**
 * The runner's answer for the slot's worktree, with Refresh and the time it
 * was read. A failure says why in a sentence, never as an empty list; the
 * last answer stays under it.
 */
function WorktreeSection({
  worktree,
  children,
}: {
  worktree: Section<SlotWorktreeView | undefined>;
  children: (view: SlotWorktreeView) => ReactNode;
}) {
  const { data, error, loading, retry } = worktree;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-3" role="status">
          {loading
            ? 'Asking the runner…'
            : data
              ? `Read ${formatAgo(data.fetchedAt)}`
              : ''}
        </span>
        <Button variant="ghost" size="sm" onClick={retry} disabled={loading}>
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Refresh
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {describeWorktreeError(error)}
        </p>
      ) : null}
      {data ? (
        children(data)
      ) : error === null ? (
        <Skeleton className="h-48 w-full" />
      ) : null}
    </div>
  );
}

export function WorktreeTab({
  worktree,
}: {
  worktree: Section<SlotWorktreeView | undefined>;
}) {
  return (
    <WorktreeSection worktree={worktree}>
      {(view) => (
        <>
          <KeyValueList
            items={[
              {
                key: 'branch',
                label: 'Branch',
                value: view.branch ?? 'detached HEAD',
                copyValue: view.branch ?? undefined,
              },
              {
                key: 'head',
                label: 'HEAD',
                value: view.head ? (
                  <code className="font-mono text-xs">
                    {shortSha(view.head)}
                  </code>
                ) : (
                  'no commits'
                ),
                copyValue: view.head ?? undefined,
              },
              { key: 'base', label: 'Base', value: view.base ?? 'none' },
              {
                key: 'ahead',
                label: 'Ahead / behind',
                value: formatAheadBehind(view.ahead, view.behind),
              },
              {
                key: 'changes',
                label: 'Uncommitted',
                value: `${pluralize(view.changed, 'changed file')} · ${pluralize(view.untracked, 'untracked file')}`,
              },
            ]}
          />
          <div className="flex flex-col items-start gap-1">
            <Button
              variant="glass"
              size="sm"
              disabled
              aria-describedby="slot-change-branch-reason"
            >
              Change branch
            </Button>
            <p id="slot-change-branch-reason" className="text-xs text-ink-3">
              {CHANGE_BRANCH_REASON}
            </p>
          </div>
          <section className="flex flex-col gap-2" aria-label="Last commits">
            <h3 className="text-sm font-semibold">Last commits</h3>
            {view.commits.length === 0 ? (
              <p className="text-sm text-ink-2">No commits on this branch.</p>
            ) : (
              <ol className="flex flex-col divide-y divide-line">
                {view.commits.map((commit) => (
                  <li key={commit.sha} className="flex flex-col gap-0.5 py-2">
                    <span className="break-words text-sm">
                      {commit.subject}
                    </span>
                    <span className="text-xs text-ink-3">
                      <code className="font-mono">{shortSha(commit.sha)}</code>{' '}
                      · {commit.author} ·{' '}
                      <time dateTime={commit.at}>
                        {formatDate(commit.at, 'datetime')}
                      </time>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </WorktreeSection>
  );
}

export function FilesTab({
  worktree,
}: {
  worktree: Section<SlotWorktreeView | undefined>;
}) {
  return (
    <WorktreeSection worktree={worktree}>
      {(view) =>
        view.files.length === 0 ? (
          <p className="text-sm text-ink-2">
            Nothing differs from {view.base ?? 'HEAD'} yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-ink-3">
              Compared with the merge base of {view.base ?? 'HEAD'}: committed,
              staged and unstaged, then untracked.
            </p>
            <ul className="flex flex-col divide-y divide-line">
              {view.files.map((file) => (
                <li
                  key={`${file.status}:${file.path}`}
                  className="flex items-baseline gap-3 py-1.5"
                >
                  <abbr
                    title={FILE_STATUS_LABEL[file.status]}
                    className="w-3 shrink-0 font-mono text-xs text-ink-2 no-underline"
                  >
                    {FILE_STATUS_MARK[file.status]}
                  </abbr>
                  <span className="min-w-0 flex-1 break-all font-mono text-xs">
                    {file.path}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-ink-2">
                    {formatLineCounts(file.additions, file.deletions)}
                  </span>
                </li>
              ))}
            </ul>
            {view.filesTruncated > 0 ? (
              <p className="text-xs text-ink-3">
                {pluralize(view.filesTruncated, 'more file')} not shown.
              </p>
            ) : null}
          </div>
        )
      }
    </WorktreeSection>
  );
}
