import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SLOT_MESSAGE_SEEN_MAX_BYTES } from '@agentdock/shared/protocol';
import { messageFileContent } from '../../control/slot';
import { brief, fleetFixture } from '../../fleet/testing';
import { tempDir } from '../../testing/fixtures';
import { MessageWatcher, messageHeader, newMessage } from './messages';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

describe('newMessage', () => {
  it('is the appended suffix when the file grew by appending', () => {
    expect(newMessage('# one\n', '# one\n\n## two\nmore\n')).toEqual({
      body: '## two\nmore',
      mode: 'appended',
    });
  });

  it('is the whole file when it was replaced, or read for the first time', () => {
    expect(newMessage('# one\n', '# other\n')).toEqual({
      body: '# other',
      mode: 'replaced',
    });
    expect(newMessage(undefined, '# one\n')).toEqual({
      body: '# one',
      mode: 'replaced',
    });
    // Shrunk to a prefix of itself is a rewrite, not an append.
    expect(newMessage('# one\nmore\n', '# one\n')).toEqual({
      body: '# one',
      mode: 'replaced',
    });
  });

  it('is nothing when only whitespace was added', () => {
    expect(newMessage('# one\n', '# one\n\n\n')).toBeNull();
    expect(newMessage(undefined, '  \n')).toBeNull();
  });
});

describe('messageHeader', () => {
  it("reads AgentDock's From / Date header", () => {
    const body = messageFileContent(
      { from: 'ops@acme.dev', text: 'rebase please' },
      '2026-10-14T09:00:00.000Z',
    );
    expect(messageHeader(body)).toEqual({
      sender: 'ops@acme.dev',
      sentAt: '2026-10-14T09:00:00.000Z',
    });
  });

  it("reads the skill's `From …:` title, and nothing from a plain body", () => {
    expect(
      messageHeader('# From the orchestrator (fd): plan approved\n\nok'),
    ).toEqual({ sender: 'the orchestrator (fd)' });
    expect(
      messageHeader('## From the orchestrator (fd): two files\n\nx'),
    ).toEqual({ sender: 'the orchestrator (fd)' });
    expect(messageHeader('just text\nDate: tomorrow')).toEqual({});
  });
});

describe('MessageWatcher', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  const setup = () => {
    const f = fleetFixture();
    f.book.worktrees.set('i42', { path: dir, branch: 'feat/42-x' });
    const file = join(dir, '.orchestrator-msg.md');
    let bump = 0;
    const touch = () => {
      bump += 1;
      utimesSync(file, new Date(), new Date(Date.now() + bump * 1000));
    };
    return { ...f, file, touch, watcher: new MessageWatcher(f) };
  };

  it('sends the first message whole, then an appended section as its own entry', () => {
    const { watcher, events, file, touch } = setup();
    const first = '# From the orchestrator (fd): plan approved\n\nGo.\n';
    writeFileSync(file, first);
    watcher.scan();
    watcher.scan();
    const second = '\n## From the orchestrator (fd): fence change\n\nx\n';
    appendFileSync(file, second);
    touch();
    watcher.scan();
    expect(brief(events.take())).toEqual([
      {
        type: 'slot.message_seen',
        slot: 'i42',
        data: {
          body: first.trim(),
          sender: 'the orchestrator (fd)',
          mode: 'replaced',
          fileHash: sha256(first),
        },
      },
      {
        type: 'slot.message_seen',
        slot: 'i42',
        data: {
          body: second.trim(),
          sender: 'the orchestrator (fd)',
          mode: 'appended',
          fileHash: sha256(first + second),
        },
      },
    ]);
  });

  it('sends a replaced file whole', () => {
    const { watcher, events, file, touch } = setup();
    writeFileSync(file, '# one\n');
    watcher.scan();
    const content = messageFileContent(
      { from: 'ops@acme.dev', text: 'stop' },
      '2026-10-14T09:00:00.000Z',
    );
    writeFileSync(file, content);
    touch();
    watcher.scan();
    const [, replaced] = events.take();
    expect(replaced.type).toBe('slot.message_seen');
    expect(replaced.source).toBe('scraped');
    expect(replaced.data).toEqual({
      body: content.trim(),
      sender: 'ops@acme.dev',
      sentAt: '2026-10-14T09:00:00.000Z',
      mode: 'replaced',
      fileHash: sha256(content),
    });
  });

  it('after a restart sends the unchanged file again, under the same hash', () => {
    const { watcher, events, file, book, emit } = setup();
    writeFileSync(file, '# one\n\n## two\n');
    watcher.scan();
    new MessageWatcher({ book, emit }).scan();
    const [before, after] = events.take();
    expect(after.data).toEqual(before.data);
  });

  it('ignores a touch without a change, a missing file and a whitespace append', () => {
    const { watcher, events, file, touch } = setup();
    watcher.scan();
    writeFileSync(file, '# one\n');
    watcher.scan();
    touch();
    watcher.scan();
    appendFileSync(file, '\n\n');
    touch();
    watcher.scan();
    expect(events.take()).toHaveLength(1);
  });

  it('caps the body in bytes', () => {
    const { watcher, events, file } = setup();
    writeFileSync(file, 'é'.repeat(SLOT_MESSAGE_SEEN_MAX_BYTES));
    watcher.scan();
    const [event] = events.take();
    const data = event.data as { body: string };
    expect(new TextEncoder().encode(data.body).length).toBe(
      SLOT_MESSAGE_SEEN_MAX_BYTES,
    );
  });
});
