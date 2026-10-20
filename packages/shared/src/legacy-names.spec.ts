import { describe, expect, it } from 'bun:test';
import {
  bothEnvNames,
  legacyEnvName,
  legacySessionName,
  readEnv,
} from './legacy-names';
import { cardTmuxSessionSchema } from './protocol/commands/cards';
import { skillRunSessionSchema } from './protocol/commands/skills';
import { manualTmuxSessionSchema } from './protocol/events/hooks';

describe('legacy names (ADR-0073)', () => {
  it('maps a NAUTELLE_ variable to its AGENTDOCK_ name', () => {
    expect(legacyEnvName('NAUTELLE_RAW')).toBe('AGENTDOCK_RAW');
    expect(legacyEnvName('PATH')).toBeNull();
  });

  it('reads the new name first and the legacy one when it is unset', () => {
    expect(
      readEnv({ NAUTELLE_RAW: '1', AGENTDOCK_RAW: '0' }, 'NAUTELLE_RAW'),
    ).toBe('1');
    expect(readEnv({ AGENTDOCK_RAW: '1' }, 'NAUTELLE_RAW')).toBe('1');
    expect(readEnv({ NAUTELLE_RAW: '' }, 'NAUTELLE_RAW')).toBe('');
    expect(readEnv({}, 'NAUTELLE_RAW')).toBeUndefined();
    expect(readEnv({ PATH: '/bin' }, 'PATH')).toBe('/bin');
  });

  it('sets a child variable under both names', () => {
    expect(bothEnvNames('NAUTELLE_CARD', 'ab12cd34')).toEqual({
      NAUTELLE_CARD: 'ab12cd34',
      AGENTDOCK_CARD: 'ab12cd34',
    });
    expect(bothEnvNames('PATH', '/bin')).toEqual({ PATH: '/bin' });
  });

  it('maps a session name to the one it had before the rename', () => {
    expect(legacySessionName('nautelle-card-ab12cd34')).toBe(
      'agentdock-card-ab12cd34',
    );
    expect(legacySessionName('cs-api')).toBeNull();
  });

  it('accepts sessions started under either prefix', () => {
    for (const prefix of ['nautelle', 'agentdock']) {
      expect(
        cardTmuxSessionSchema.safeParse(`${prefix}-card-ab12cd34`).success,
      ).toBe(true);
      expect(
        skillRunSessionSchema.safeParse(`${prefix}-run-a1b2c3`).success,
      ).toBe(true);
      expect(
        manualTmuxSessionSchema.safeParse(`${prefix}-manual-0a1b2c3d`).success,
      ).toBe(true);
    }
    expect(cardTmuxSessionSchema.safeParse('other-card-ab12cd34').success).toBe(
      false,
    );
  });
});
