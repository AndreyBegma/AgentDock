import { describe, expect, it } from 'bun:test';
import {
  ISSUES_SNAPSHOT_PART_MAX_BYTES,
  issuesSnapshotDataSchema,
} from '@agentdock/shared/protocol';
import type { Listing } from './listing';
import { splitSnapshot } from './split';

const META = { snapshotId: 's1', fetchedAt: '2026-10-08T10:00:00.000Z' };
const bytes = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v)).length;

const issue = (number: number, body: string) => ({
  number,
  title: `Issue ${number}`,
  labels: ['cs:ready'],
  assignees: [],
  body,
  updatedAt: '2026-10-08T09:00:00Z',
  url: `https://github.com/acme/widget/issues/${number}`,
});

const listing = (issues: ReturnType<typeof issue>[]): Listing => ({
  issues,
  pullRequests: [
    {
      number: 900,
      title: 'PR',
      body: 'Closes #1',
      updatedAt: '2026-10-08T09:00:00Z',
      url: 'https://github.com/acme/widget/pull/900',
    },
  ],
  open: [...issues.map((i) => i.number), 900],
});

describe('splitSnapshot', () => {
  it('keeps a small listing in one part', () => {
    const parts = splitSnapshot(listing([issue(1, 'x')]), META);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ part: 0, parts: 1, open: [1, 900] });
  });

  it('splits a large listing into parts under the cap, each with the full open list', () => {
    // 60 issues of ~60 KB: ~3.6 MB, far over one part.
    const big = Array.from({ length: 60 }, (_, i) =>
      issue(i + 1, 'é'.repeat(30_000)),
    );
    const input = listing(big);
    const parts = splitSnapshot(input, META);
    expect(parts.length).toBeGreaterThan(1);
    for (const [i, part] of parts.entries()) {
      expect(bytes(part)).toBeLessThanOrEqual(ISSUES_SNAPSHOT_PART_MAX_BYTES);
      expect(part).toMatchObject({
        part: i,
        parts: parts.length,
        snapshotId: 's1',
      });
      expect(part.open).toEqual(input.open);
      expect(issuesSnapshotDataSchema.safeParse(part).success).toBe(true);
    }
    const numbers = parts.flatMap((p) => [
      ...p.issues.map((x) => x.number),
      ...p.pullRequests.map((x) => x.number),
    ]);
    expect(numbers.sort((a, b) => a - b)).toEqual(
      input.open.slice().sort((a, b) => a - b),
    );
  });

  it('shrinks the body of one item that alone exceeds the cap', () => {
    // Escapes double the serialized size of this body.
    const parts = splitSnapshot(
      listing([issue(1, '"\n'.repeat(60_000))]),
      META,
    );
    for (const part of parts) {
      expect(bytes(part)).toBeLessThanOrEqual(ISSUES_SNAPSHOT_PART_MAX_BYTES);
    }
    expect(parts.flatMap((p) => p.issues)).toHaveLength(1);
  });
});
