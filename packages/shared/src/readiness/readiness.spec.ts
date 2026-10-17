import { describe, expect, it } from 'bun:test';
import type { RuntimeProfilePick } from './pick-profile';
import {
  type ProjectReadiness,
  projectReadiness,
  READINESS_ACTIONS,
  type ReadinessBlocker,
  type ReadinessFacts,
} from './readiness';

const usable: RuntimeProfilePick = {
  ok: true,
  source: 'default',
  profile: {
    id: 'p1',
    key: 'main',
    label: 'Main',
    runtime: 'claude',
    runnerId: 'r1',
    missing: false,
  },
};

const ready: ReadinessFacts = {
  profile: usable,
  runnerConnected: true,
  missingCommands: [],
  specTarget: 'code_repo',
  shipSessionContent: true,
};

const none: ProjectReadiness = {
  design: [],
  run: [],
  capture: [],
  spec_on_run: [],
  plan: [],
};

describe('projectReadiness', () => {
  it('has no blocker for a ready project', () => {
    expect(projectReadiness(ready)).toEqual(none);
  });

  it('lists every action', () => {
    expect(Object.keys(projectReadiness(ready)).sort()).toEqual(
      [...READINESS_ACTIONS].sort(),
    );
  });

  it('blocks every model action with no profile, not spec_on_run', () => {
    const result = projectReadiness({
      ...ready,
      profile: { ok: false, reason: 'none', source: null, profile: null },
    });
    const blocker: ReadinessBlocker = {
      code: 'no_profile',
      reason: 'none',
      source: null,
    };
    expect(result).toEqual({
      design: [blocker],
      run: [blocker],
      capture: [blocker],
      spec_on_run: [],
      plan: [blocker],
    });
  });

  it('carries the reason, source and key of an unusable profile', () => {
    const result = projectReadiness({
      ...ready,
      profile: {
        ok: false,
        reason: 'not_claude',
        source: 'orchestrator',
        profileKey: 'codex',
        profile: null,
      },
    });
    expect(result.run).toEqual([
      {
        code: 'no_profile',
        reason: 'not_claude',
        source: 'orchestrator',
        profileKey: 'codex',
      },
    ]);
  });

  it('blocks every model action when the runner is disconnected', () => {
    const result = projectReadiness({
      ...ready,
      runnerConnected: false,
      missingCommands: ['card.run'],
    });
    const offline: ReadinessBlocker[] = [{ code: 'runner_offline' }];
    expect(result).toEqual({
      design: offline,
      run: offline,
      capture: offline,
      spec_on_run: [],
      plan: offline,
    });
  });

  it('blocks only the actions whose command is missing from the advert', () => {
    expect(
      projectReadiness({ ...ready, missingCommands: ['uiprofile.build'] }),
    ).toEqual({
      ...none,
      design: [{ code: 'runner_outdated', commands: ['uiprofile.build'] }],
    });
    expect(
      projectReadiness({ ...ready, missingCommands: ['plan.turn'] }),
    ).toEqual({
      ...none,
      design: [{ code: 'runner_outdated', commands: ['plan.turn'] }],
      plan: [{ code: 'runner_outdated', commands: ['plan.turn'] }],
    });
    expect(
      projectReadiness({ ...ready, missingCommands: ['card.run'] }),
    ).toEqual({
      ...none,
      run: [{ code: 'runner_outdated', commands: ['card.run'] }],
    });
    expect(
      projectReadiness({ ...ready, missingCommands: ['cards.extract'] }),
    ).toEqual({
      ...none,
      capture: [{ code: 'runner_outdated', commands: ['cards.extract'] }],
    });
  });

  it('blocks spec_on_run without a spec directory', () => {
    expect(projectReadiness({ ...ready, specTarget: 'no_spec_dir' })).toEqual({
      ...none,
      spec_on_run: [{ code: 'no_spec_dir' }],
    });
  });

  it('blocks spec_on_run on a remote docs repository without a clone (#379)', () => {
    expect(projectReadiness({ ...ready, specTarget: 'no_docs_clone' })).toEqual(
      { ...none, spec_on_run: [{ code: 'no_docs_clone' }] },
    );
  });

  it('lets spec_on_run write to a docs repository the runner serves (#379)', () => {
    expect(projectReadiness({ ...ready, specTarget: 'docs_repo' })).toEqual(
      none,
    );
    expect(
      projectReadiness({
        ...ready,
        specTarget: 'docs_repo',
        missingCommands: ['docs.publish_specs'],
      }),
    ).toEqual({
      ...none,
      spec_on_run: [
        { code: 'runner_outdated', commands: ['docs.publish_specs'] },
      ],
    });
  });

  it('blocks capture with session content off', () => {
    expect(projectReadiness({ ...ready, shipSessionContent: false })).toEqual({
      ...none,
      capture: [{ code: 'content_off' }],
    });
  });

  it('lists several blockers of one action in a stable order', () => {
    expect(
      projectReadiness({
        ...ready,
        profile: { ok: false, reason: 'none', source: null, profile: null },
        runnerConnected: false,
        shipSessionContent: false,
      }).capture.map((b) => b.code),
    ).toEqual(['no_profile', 'runner_offline', 'content_off']);
  });
});
