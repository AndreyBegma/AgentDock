import { describe, expect, it } from 'bun:test';
import {
  noProfileDetails,
  noProfileMessage,
  type ProfileCandidate,
  pickRuntimeProfile,
  suggestRuntimeProfile,
} from './pick-profile';

const RUNNER = 'runner-1';

const profile = (
  key: string,
  over: Partial<ProfileCandidate> = {},
): ProfileCandidate => ({
  id: `id-${key}`,
  key,
  label: key,
  runtime: 'claude',
  runnerId: RUNNER,
  missing: false,
  ...over,
});

describe('pickRuntimeProfile', () => {
  const orch = profile('orch');
  const def = profile('def');
  const named = profile('named');

  it('takes the explicit key first', () => {
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        explicit: { key: 'named', profile: named },
        orchestrator: orch,
        default: def,
      }),
    ).toEqual({ ok: true, profile: named, source: 'explicit' });
  });

  it('takes the orchestrator profile before the default', () => {
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        orchestrator: orch,
        default: def,
      }),
    ).toEqual({ ok: true, profile: orch, source: 'orchestrator' });
  });

  it('takes the default when nothing else is set', () => {
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        explicit: null,
        orchestrator: null,
        default: def,
      }),
    ).toEqual({ ok: true, profile: def, source: 'default' });
  });

  it('answers none when nothing is set', () => {
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        orchestrator: null,
        default: null,
      }),
    ).toEqual({ ok: false, reason: 'none', source: null, profile: null });
  });

  it('never falls through from an unusable orchestrator profile', () => {
    const codex = profile('codex', { runtime: 'codex' });
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        orchestrator: codex,
        default: def,
      }),
    ).toEqual({
      ok: false,
      reason: 'not_claude',
      source: 'orchestrator',
      profileKey: 'codex',
      profile: codex,
    });
  });

  it('refuses a missing default with its source', () => {
    const gone = profile('gone', { missing: true });
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        orchestrator: null,
        default: gone,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'missing',
      source: 'default',
      profileKey: 'gone',
    });
  });

  it('refuses a profile of another runner', () => {
    const other = profile('other', { runnerId: 'runner-2' });
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        orchestrator: null,
        default: other,
      }),
    ).toMatchObject({ ok: false, reason: 'not_on_runner', source: 'default' });
  });

  it('refuses an explicit key that matches no profile, without falling through', () => {
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        explicit: { key: 'ghost', profile: null },
        orchestrator: orch,
        default: def,
      }),
    ).toEqual({
      ok: false,
      reason: 'not_on_runner',
      source: 'explicit',
      profileKey: 'ghost',
      profile: null,
    });
  });

  it('checks the runner before missing, and missing before the runtime', () => {
    const all = profile('all', {
      runnerId: 'runner-2',
      missing: true,
      runtime: 'codex',
    });
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        orchestrator: null,
        default: all,
      }),
    ).toMatchObject({ reason: 'not_on_runner' });
    const gone = profile('gone', { missing: true, runtime: 'codex' });
    expect(
      pickRuntimeProfile({
        runnerId: RUNNER,
        orchestrator: null,
        default: gone,
      }),
    ).toMatchObject({ reason: 'missing' });
  });
});

describe('noProfileDetails', () => {
  it('is null for a usable pick', () => {
    expect(
      noProfileDetails(
        pickRuntimeProfile({
          runnerId: RUNNER,
          orchestrator: null,
          default: profile('def'),
        }),
      ),
    ).toBeNull();
  });

  it('carries reason, source and key', () => {
    expect(
      noProfileDetails(
        pickRuntimeProfile({
          runnerId: RUNNER,
          orchestrator: profile('x', { missing: true }),
          default: null,
        }),
      ),
    ).toEqual({ reason: 'missing', source: 'orchestrator', profileKey: 'x' });
  });
});

describe('noProfileMessage', () => {
  it('names Settings › General when nothing is set', () => {
    expect(noProfileMessage({ reason: 'none', source: null })).toBe(
      'This project has no runtime profile. An admin sets the default in Settings › General.',
    );
  });

  it('names a Codex default and Settings › General', () => {
    const message = noProfileMessage({
      reason: 'not_claude',
      source: 'default',
      profileKey: 'codex-main',
      runtime: 'codex',
    });
    expect(message).toContain('codex-main is a codex profile');
    expect(message).toContain('Claude profile');
    expect(message).toContain('Settings › General');
  });

  it('names Settings › Orchestrator for the orchestrator profile', () => {
    expect(
      noProfileMessage({
        reason: 'missing',
        source: 'orchestrator',
        profileKey: 'orch',
      }),
    ).toContain('Settings › Orchestrator');
  });
});

describe('suggestRuntimeProfile', () => {
  it('is the only usable Claude profile on the runner', () => {
    const only = profile('only', { label: 'Zed' });
    expect(
      suggestRuntimeProfile(
        [
          profile('codex', { runtime: 'codex', label: 'A' }),
          profile('gone', { missing: true, label: 'B' }),
          profile('far', { runnerId: 'runner-2', label: 'C' }),
          only,
        ],
        RUNNER,
      ),
    ).toBe(only);
  });

  it('is the first by label when there are several', () => {
    const alpha = profile('z-key', { label: 'Alpha' });
    expect(
      suggestRuntimeProfile(
        [profile('a-key', { label: 'Beta' }), alpha],
        RUNNER,
      ),
    ).toBe(alpha);
  });

  it('is null when none is usable', () => {
    expect(
      suggestRuntimeProfile([profile('c', { runtime: 'codex' })], RUNNER),
    ).toBeNull();
  });
});
