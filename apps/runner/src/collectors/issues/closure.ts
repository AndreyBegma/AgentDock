import type { IssueClosedData } from '@agentdock/shared/protocol';
import { z } from 'zod';
import type { Exec } from '../../detect/exec';
import { GH_API_TIMEOUT_MS } from './listing';

const TIMELINE_PAGE = 100;
const TIMELINE_MAX_PAGES = 10;

const eventSchema = z.looseObject({
  event: z.string(),
  created_at: z.string().nullish(),
  commit_id: z.string().nullish(),
  source: z
    .looseObject({
      issue: z
        .looseObject({
          number: z.number().int().positive(),
          pull_request: z
            .looseObject({ merged_at: z.string().nullish() })
            .nullish(),
          repository: z.looseObject({ full_name: z.string() }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
type TimelineEvent = z.infer<typeof eventSchema>;

/**
 * How the timeline says an issue was closed. A merged pull request closes an
 * issue with a `closed` event that carries a `commit_id` and leaves a
 * `cross-referenced` event from that (merged, same-repository) pull request;
 * anything else — a click on Close, a bare commit — is `manual` (spec 19 D2).
 */
export const closureOf = (
  events: readonly TimelineEvent[],
  number: number,
  repo: string,
): IssueClosedData => {
  const closed = events.filter((e) => e.event === 'closed').at(-1);
  const closedAt = closed?.created_at ?? undefined;
  const at = closedAt ? { closedAt } : {};
  if (!closed?.commit_id) return { number, closedBy: 'manual', ...at };
  const merged = events.find((e) => {
    const source = e.source?.issue;
    return (
      e.event === 'cross-referenced' &&
      source?.pull_request?.merged_at &&
      (!source.repository || source.repository.full_name === repo)
    );
  });
  const pr = merged?.source?.issue?.number;
  return pr
    ? { number, closedBy: 'pr', pr, ...at }
    : { number, closedBy: 'manual', ...at };
};

/**
 * Reads issue `number`'s timeline and says how it was closed. Null when the
 * timeline cannot be read, or the issue is not closed after all — the caller
 * tries again at the next tick.
 */
export const fetchClosure = async (
  exec: Exec,
  repo: string,
  number: number,
): Promise<IssueClosedData | null> => {
  const events: TimelineEvent[] = [];
  for (let page = 1; page <= TIMELINE_MAX_PAGES; page++) {
    const result = await exec(
      'gh',
      [
        'api',
        `repos/${repo}/issues/${number}/timeline?per_page=${TIMELINE_PAGE}&page=${page}`,
      ],
      { timeoutMs: GH_API_TIMEOUT_MS },
    );
    if (!result || result.code !== 0) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(raw)) return null;
    for (const entry of raw) {
      const parsed = eventSchema.safeParse(entry);
      if (parsed.success) events.push(parsed.data);
    }
    if (raw.length < TIMELINE_PAGE) break;
  }
  if (!events.some((e) => e.event === 'closed')) return null;
  return closureOf(events, number, repo);
};
