import { describe, expect, it } from 'bun:test';
import { PANE_FIELD_SEP, parsePanes, sessionPanes, Tmux } from './tmux';

const line = (...fields: string[]) => fields.join(PANE_FIELD_SEP);

describe('parsePanes', () => {
  it('reads every field, keeping a separator inside the start command', () => {
    const panes = parsePanes(
      [
        line('cs-i42', '%3', '1', '4242', '/srv/.wt-widget-i42', 'sleep 600'),
        line('work', '%4', '0', '', '/srv/my dir', 'a', 'b'),
        'garbage',
        '',
      ].join('\n'),
    );
    expect(panes).toEqual([
      {
        session: 'cs-i42',
        paneId: '%3',
        active: true,
        path: '/srv/.wt-widget-i42',
        pid: 4242,
        startCommand: 'sleep 600',
      },
      {
        session: 'work',
        paneId: '%4',
        active: false,
        path: '/srv/my dir',
        pid: null,
        startCommand: `a${PANE_FIELD_SEP}b`,
      },
    ]);
  });

  it('picks the active pane of a session', () => {
    const panes = parsePanes(
      [
        line('s', '%1', '0', '1', '/a', ''),
        line('s', '%2', '1', '2', '/b', ''),
      ].join('\n'),
    );
    expect(sessionPanes(panes).get('s')?.paneId).toBe('%2');
  });
});

describe('Tmux', () => {
  it('reads no server as no panes, and no tmux as unknown', async () => {
    const calls: string[][] = [];
    const noServer = new Tmux(
      async (_, args) => {
        calls.push([...args]);
        return { code: 1, stdout: '', stderr: 'no server running' };
      },
      ['-L', 'private'],
    );
    expect(await noServer.panes()).toEqual([]);
    expect(calls[0].slice(0, 4)).toEqual(['-L', 'private', 'list-panes', '-a']);
    expect(await new Tmux(async () => null).panes()).toBeNull();
  });
});
