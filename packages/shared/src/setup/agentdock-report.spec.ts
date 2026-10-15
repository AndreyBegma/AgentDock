import { describe, expect, it } from 'bun:test';
import { capabilitiesSchema } from '../protocol';
import { profileAgentdockOf } from './agentdock-report';

const profile = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  runtime: 'claude',
  env: {},
  args: [],
  authenticated: true,
  ...extra,
});

const capabilities = (profiles: unknown[]) => ({
  tmux: null,
  git: null,
  gh: null,
  runtimes: { claude: null, codex: null },
  profiles,
  codeSentinel: null,
  otlp: null,
});

describe('runtimeProfileSchema.agentdock', () => {
  it('accepts a hello without the field — an older runner', () => {
    expect(
      capabilitiesSchema.safeParse(capabilities([profile('main')])).success,
    ).toBe(true);
  });

  it('accepts a reported version, or null', () => {
    for (const agentdock of [
      { plugin: '0.3.0', telemetry: true },
      { plugin: null, telemetry: false },
    ]) {
      expect(
        capabilitiesSchema.safeParse(
          capabilities([profile('main', { agentdock })]),
        ).success,
      ).toBe(true);
    }
  });

  it('rejects an empty version', () => {
    expect(
      capabilitiesSchema.safeParse(
        capabilities([
          profile('main', { agentdock: { plugin: '', telemetry: true } }),
        ]),
      ).success,
    ).toBe(false);
  });
});

describe('profileAgentdockOf', () => {
  it('reads each profile’s report by key', () => {
    expect(
      profileAgentdockOf(
        capabilities([
          profile('main', { agentdock: { plugin: '0.3.0', telemetry: true } }),
          profile('alt', { agentdock: { plugin: null, telemetry: false } }),
        ]),
      ),
    ).toEqual({
      main: { plugin: '0.3.0', telemetry: true },
      alt: { plugin: null, telemetry: false },
    });
  });

  it('leaves out a profile with no report — unknown, not missing', () => {
    expect(
      profileAgentdockOf(
        capabilities([
          profile('old'),
          profile('cx', { runtime: 'codex' }),
          profile('main', { agentdock: { plugin: '0.3.0', telemetry: false } }),
        ]),
      ),
    ).toEqual({ main: { plugin: '0.3.0', telemetry: false } });
  });

  it('keeps the good entries next to a malformed one', () => {
    expect(
      profileAgentdockOf({
        profiles: [
          { id: 'bad', agentdock: { plugin: 7 } },
          'not a profile',
          { id: 'main', agentdock: { plugin: null, telemetry: true } },
        ],
      }),
    ).toEqual({ main: { plugin: null, telemetry: true } });
  });

  it('is empty for JSON that is not a capabilities object', () => {
    for (const value of [null, undefined, 'x', 7, [], { profiles: 'x' }]) {
      expect(profileAgentdockOf(value)).toEqual({});
    }
  });

  it('keeps the first of two entries with one key', () => {
    expect(
      profileAgentdockOf({
        profiles: [
          { id: 'main', agentdock: { plugin: '1.0.0', telemetry: true } },
          { id: 'main', agentdock: { plugin: null, telemetry: false } },
        ],
      }),
    ).toEqual({ main: { plugin: '1.0.0', telemetry: true } });
  });
});
