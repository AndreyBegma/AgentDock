'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import type { SlotConversation, SlotDetail } from '@nautelle/shared';
import { Markdown } from '../../../../../../components/markdown/markdown';
import {
  CHECKS_LABEL,
  CHECKS_TONE,
  formatAgo,
} from '../../../../../../lib/fleet/format';
import { lastLocalChecks } from '../../../../../../lib/slot/format';
import { githubUrl } from '../../../../../../lib/url';

/**
 * The pull request's checks, as GitHub reports them, and the worker's own
 * last word on local checks: its latest `implementation done` section.
 */
export function TestsTab({
  slot,
  conversation,
}: {
  slot: SlotDetail;
  conversation: SlotConversation | undefined;
}) {
  const prHref = githubUrl(slot.prUrl);
  const local = conversation
    ? lastLocalChecks(conversation.entries)
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label="Pull request checks">
        <h3 className="text-sm font-semibold">Pull request</h3>
        {slot.prNumber === null ? (
          <p className="text-sm text-ink-2">
            No pull request yet. Its checks show here once the worker opens one.
          </p>
        ) : (
          <KeyValueList
            items={[
              {
                key: 'pr',
                label: 'Number',
                value: prHref ? (
                  <a
                    href={prHref}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-ink underline-offset-2 hover:underline"
                  >
                    #{slot.prNumber}
                  </a>
                ) : (
                  `#${slot.prNumber}`
                ),
              },
              { key: 'state', label: 'State', value: slot.prState ?? '—' },
              {
                key: 'checks',
                label: 'Checks',
                value: slot.prChecks ? (
                  <Badge
                    tone={CHECKS_TONE[slot.prChecks]}
                    label={CHECKS_LABEL[slot.prChecks]}
                  />
                ) : (
                  'not reported yet'
                ),
              },
              {
                key: 'mergeable',
                label: 'Mergeable',
                value:
                  slot.prMergeable === null
                    ? '—'
                    : slot.prMergeable
                      ? 'yes'
                      : 'conflicts',
              },
            ]}
          />
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Local checks">
        <h3 className="text-sm font-semibold">Local checks</h3>
        {local ? (
          <>
            <p className="text-xs text-ink-3">
              {`From the worker’s “${local.heading}” section, ${formatAgo(local.at)}.`}
            </p>
            <div className="rounded-control bg-surface p-3">
              <Markdown compact>{local.body}</Markdown>
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-2">
            Not reported yet. The worker reports its checks when it writes
            “implementation done”.
          </p>
        )}
      </section>
    </div>
  );
}
