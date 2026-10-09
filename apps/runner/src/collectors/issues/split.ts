import {
  ISSUES_SNAPSHOT_PART_MAX_BYTES,
  type IssuesSnapshotData,
  type SnapshotIssue,
  type SnapshotPullRequest,
} from '@agentdock/shared/protocol';
import { type Listing, truncateUtf8 } from './listing';

const sizeOf = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

type Item =
  | { kind: 'issue'; value: SnapshotIssue }
  | { kind: 'pr'; value: SnapshotPullRequest };

/** Headroom for `part`/`parts` digits and the commas between items. */
const SLACK = 64;

/**
 * Splits a listing into snapshot parts (spec 19 D2, note 2): each part's
 * serialized `data` is at most `maxBytes`, every issue and pull request is in
 * exactly one part, and every part carries the complete `open` list.
 * An item that alone exceeds the budget has its body halved until it fits.
 */
export const splitSnapshot = (
  listing: Listing,
  meta: { snapshotId: string; fetchedAt: string },
  maxBytes = ISSUES_SNAPSHOT_PART_MAX_BYTES,
): IssuesSnapshotData[] => {
  const open = [...new Set(listing.open)];
  const frame = {
    ...meta,
    part: 0,
    parts: 1,
    open,
    issues: [],
    pullRequests: [],
  };
  const budget = maxBytes - sizeOf(frame) - SLACK;

  const fit = (item: Item): Item => {
    let value = item.value;
    while (sizeOf(value) > budget && value.body.length > 0) {
      const body = truncateUtf8(
        value.body,
        Math.floor(new TextEncoder().encode(value.body).length / 2),
      );
      value = { ...value, body } as typeof value;
    }
    return { kind: item.kind, value } as Item;
  };

  const items: Item[] = [
    ...listing.issues.map((value): Item => ({ kind: 'issue', value })),
    ...listing.pullRequests.map((value): Item => ({ kind: 'pr', value })),
  ].map(fit);

  const groups: Item[][] = [[]];
  let used = 0;
  for (const item of items) {
    const size = sizeOf(item.value) + 1;
    if (used + size > budget && groups[groups.length - 1].length > 0) {
      groups.push([]);
      used = 0;
    }
    groups[groups.length - 1].push(item);
    used += size;
  }

  return groups.map((group, part) => ({
    ...meta,
    part,
    parts: groups.length,
    open,
    issues: group.flatMap((i) => (i.kind === 'issue' ? [i.value] : [])),
    pullRequests: group.flatMap((i) => (i.kind === 'pr' ? [i.value] : [])),
  }));
};
