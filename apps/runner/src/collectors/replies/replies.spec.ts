import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKPOINT_SUMMARY_MAX_BYTES } from '@agentdock/shared/protocol';
import { brief, fleetFixture } from '../../fleet/testing';
import { tempDir } from '../../testing/fixtures';
import {
  checkpointData,
  parseReply,
  ReplyWatcher,
  truncateBytes,
} from './replies';

describe('parseReply', () => {
  it('splits on ## headings, keeping deeper headings and fenced blocks in the body', () => {
    expect(
      parseReply(
        [
          'preamble',
          '## picked up',
          'i42 · #42',
          '',
          '## plan ready',
          '### Steps',
          '```md',
          '## not a heading',
          '```',
          '## blocked ##',
        ].join('\n'),
      ),
    ).toEqual([
      { heading: 'picked up', body: 'i42 · #42' },
      {
        heading: 'plan ready',
        body: '### Steps\n```md\n## not a heading\n```',
      },
      { heading: 'blocked', body: '' },
    ]);
  });
});

describe('checkpointData', () => {
  it('maps the heading, keeps the PR URL and caps the summary in bytes', () => {
    const data = checkpointData(
      {
        heading: 'pull request open — https://github.com/acme/widget/pull/7',
        body: 'é'.repeat(CHECKPOINT_SUMMARY_MAX_BYTES),
      },
      3,
    );
    expect(data).toMatchObject({
      checkpoint: 'pr_open',
      position: 3,
      prUrl: 'https://github.com/acme/widget/pull/7',
    });
    expect(new TextEncoder().encode(data.summary).length).toBe(
      CHECKPOINT_SUMMARY_MAX_BYTES,
    );
  });

  it('never splits a character', () => {
    expect(truncateBytes('aé', 2)).toBe('a');
    expect(truncateBytes('abc', 5)).toBe('abc');
  });
});

describe('ReplyWatcher', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  const setup = () => {
    const f = fleetFixture();
    f.book.worktrees.set('i42', { path: dir, branch: 'feat/42-x' });
    const file = join(dir, '.orchestrator-reply.md');
    let bump = 0;
    const touch = () => {
      bump += 1;
      utimesSync(file, new Date(), new Date(Date.now() + bump * 1000));
    };
    return { ...f, file, touch, watcher: new ReplyWatcher(f) };
  };

  it('turns appended headings into ordered checkpoints, each once', () => {
    const { watcher, events, file, touch } = setup();
    writeFileSync(file, '## plan ready\nthe plan\n');
    watcher.scan();
    appendFileSync(
      file,
      '\n## pull request open — https://github.com/acme/widget/pull/7\nsummary\n',
    );
    touch();
    watcher.scan();
    watcher.scan();
    expect(brief(events.take())).toEqual([
      {
        type: 'slot.checkpoint',
        slot: 'i42',
        data: {
          checkpoint: 'plan_ready',
          heading: 'plan ready',
          summary: 'the plan',
          position: 0,
        },
      },
      {
        type: 'slot.checkpoint',
        slot: 'i42',
        data: {
          checkpoint: 'pr_open',
          heading: 'pull request open — https://github.com/acme/widget/pull/7',
          summary: 'summary',
          position: 1,
          prUrl: 'https://github.com/acme/widget/pull/7',
        },
      },
    ]);
  });

  it('resends a section whose body grew, and everything when the file starts over', () => {
    const { watcher, events, file, touch } = setup();
    writeFileSync(file, '## picked up\na\n## plan ready\nb\n');
    watcher.scan();
    events.take();
    appendFileSync(file, 'more of b\n');
    touch();
    watcher.scan();
    expect(events.take().map((e) => e.data)).toEqual([
      expect.objectContaining({ position: 1, summary: 'b\nmore of b' }),
    ]);
    writeFileSync(file, '## picked up\na\n');
    touch();
    watcher.scan();
    expect(events.take().map((e) => e.data)).toEqual([
      expect.objectContaining({ position: 0, checkpoint: 'picked_up' }),
    ]);
  });

  it('marks checkpoints scraped and carries the slot issue', () => {
    const { watcher, events, file } = setup();
    writeFileSync(file, '## notes\nx\n');
    watcher.scan();
    const [event] = events.take();
    expect(event).toMatchObject({
      source: 'scraped',
      slot: 'i42',
      issue: 42,
      data: { checkpoint: 'other' },
    });
  });

  it('ignores a worktree without a reply file', () => {
    const { watcher, events } = setup();
    watcher.scan();
    expect(events.take()).toEqual([]);
  });
});
