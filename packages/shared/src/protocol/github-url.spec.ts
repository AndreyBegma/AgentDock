import { describe, expect, it } from 'bun:test';
import { slotCheckpointDataSchema } from './events/fleet';
import { snapshotIssueSchema } from './events/queue';
import {
  droppableGithubUrl,
  httpsGithubUrl,
  isHttpsGithubUrl,
} from './github-url';

const REJECTED = [
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  'http://github.com/o/r/pull/1',
  'https://github.com.evil.example/o/r',
  'https://evil.example/github.com/o/r',
  'https://github.com@evil.example/o/r',
  'https://user:pw@github.com/o/r',
  'https://github.com:8443/o/r',
  'https://gist.github.com/o/r',
  'not a url',
  '',
];

describe('httpsGithubUrl', () => {
  it('accepts an https://github.com URL', () => {
    expect(httpsGithubUrl.parse('https://github.com/o/r/pull/1')).toBe(
      'https://github.com/o/r/pull/1',
    );
  });

  it.each(REJECTED)('rejects %p', (value) => {
    expect(httpsGithubUrl.safeParse(value).success).toBe(false);
    expect(isHttpsGithubUrl(value)).toBe(false);
  });
});

describe('droppableGithubUrl', () => {
  it('keeps a good URL and drops a bad one or a missing one', () => {
    expect(droppableGithubUrl.parse('https://github.com/o/r/pull/1')).toBe(
      'https://github.com/o/r/pull/1',
    );
    expect(droppableGithubUrl.parse('javascript:alert(1)')).toBeUndefined();
    expect(droppableGithubUrl.parse(undefined)).toBeUndefined();
  });

  it('keeps the event whose URL is dropped', () => {
    expect(
      slotCheckpointDataSchema.parse({
        checkpoint: 'pr_open',
        prUrl: 'https://github.com.evil.example/o/r/pull/1',
      }),
    ).toMatchObject({ checkpoint: 'pr_open', prUrl: undefined });
    expect(
      snapshotIssueSchema.parse({
        number: 1,
        title: 't',
        updatedAt: '2026-10-16T10:00:00Z',
        url: 'data:text/html,x',
      }).url,
    ).toBeUndefined();
  });
});
