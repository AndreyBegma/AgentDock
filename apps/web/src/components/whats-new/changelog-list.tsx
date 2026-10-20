import type { ChangelogEntry } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Card } from '@andrewbehma/glass-ui/card';
import {
  CHANGE_KIND_LABEL,
  CHANGE_KIND_TONE,
  releaseDateLabel,
  versionLabel,
} from '../../lib/whats-new/whats-new';

/** C-294: the releases, newest first, each with its items in written order. */
export function ChangelogList({
  entries,
}: {
  entries: readonly ChangelogEntry[];
}) {
  return (
    <ol className="flex flex-col gap-4">
      {entries.map((entry) => (
        <li key={entry.version}>
          <Card pad="lg">
            <article aria-labelledby={`release-${entry.version}`}>
              <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2
                  id={`release-${entry.version}`}
                  className="text-section font-semibold text-ink"
                >
                  {versionLabel(entry.version)}
                </h2>
                <time dateTime={entry.date} className="text-sm text-ink-3">
                  {releaseDateLabel(entry.date)}
                </time>
              </header>
              <ul className="flex flex-col gap-2">
                {entry.items.map((item) => (
                  <li key={item.text} className="flex items-start gap-3">
                    <Badge
                      size="md"
                      tone={CHANGE_KIND_TONE[item.kind]}
                      label={CHANGE_KIND_LABEL[item.kind]}
                      className="mt-0.5 w-20 shrink-0"
                    />
                    <span className="text-sm text-ink-2">{item.text}</span>
                  </li>
                ))}
              </ul>
            </article>
          </Card>
        </li>
      ))}
    </ol>
  );
}
