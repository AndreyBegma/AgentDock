import type { RunnerCommands } from '@nautelle/shared/protocol';
import type { WebSocket } from 'ws';
import { LiveConnection, RunnerConnections } from './runner-connections';
import type { RunnerOptions } from './runner-options';
import { RunnerPresence } from './runner-presence';

const OPEN = 1;
const CLOSED = 3;

const setup = () => {
  const connections = new RunnerConnections();
  const presence = new RunnerPresence(connections, {
    staleAfterMs: 60_000,
  } as RunnerOptions);
  const connect = (commands: RunnerCommands | null, readyState = OPEN) => {
    const socket = { readyState, send: jest.fn(), close: jest.fn() };
    connections.attach(
      new LiveConnection(
        'rn_1',
        socket as unknown as WebSocket,
        Date.now(),
        commands,
      ),
    );
  };
  return { presence, connect };
};

const advert: RunnerCommands = {
  commands: ['plan.turn', 'uiprofile.build', 'worktree.status'],
  disabled: ['uiprofile.build'],
};

describe('RunnerPresence.commandSupport', () => {
  it('is unknown while the runner is not connected', () => {
    const { presence, connect } = setup();
    expect(presence.commandSupport('rn_1', 'plan.turn')).toBe('unknown');
    connect(advert, CLOSED);
    expect(presence.commandSupport('rn_1', 'plan.turn')).toBe('unknown');
  });

  it('is unknown for a connected runner that advertised nothing', () => {
    const { presence, connect } = setup();
    connect(null);
    expect(presence.commandSupport('rn_1', 'plan.turn')).toBe('unknown');
    expect(presence.missingCommand('rn_1', ['plan.turn'])).toBeNull();
  });

  it("reads the live connection's advert", () => {
    const { presence, connect } = setup();
    connect(advert);
    expect(presence.commandSupport('rn_1', 'plan.turn')).toBe('supported');
    expect(presence.commandSupport('rn_1', 'uiprofile.build')).toBe('disabled');
    expect(presence.commandSupport('rn_1', 'uiprofile.fingerprint')).toBe(
      'missing',
    );
  });

  it('names the first missing command; disabled ones pass', () => {
    const { presence, connect } = setup();
    connect(advert);
    expect(
      presence.missingCommand('rn_1', [
        'plan.turn',
        'uiprofile.build',
        'uiprofile.fingerprint',
      ]),
    ).toBe('uiprofile.fingerprint');
    expect(
      presence.missingCommand('rn_1', ['plan.turn', 'uiprofile.build']),
    ).toBeNull();
  });

  it('follows a reconnect with a newer advert', () => {
    const { presence, connect } = setup();
    connect({ commands: ['worktree.status'], disabled: [] });
    expect(presence.commandSupport('rn_1', 'plan.turn')).toBe('missing');
    connect(advert);
    expect(presence.commandSupport('rn_1', 'plan.turn')).toBe('supported');
  });
});
