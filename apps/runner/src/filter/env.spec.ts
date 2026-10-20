import { describe, expect, it } from 'bun:test';
import {
  FILTER_ID_NONE,
  TOKEN_SAVER_RAW_ENV,
  TOKEN_SAVER_RUN_KINDS,
} from '@nautelle/shared';
import { FILTER_NONE } from './engine';
import {
  FILTER_PROJECT_ENV,
  FILTER_RUN_ENV,
  FILTER_RUN_KIND_ENV,
  FILTER_STATS_ENV,
  filterEnv,
  orchestratorFilterDir,
  RAW_ENV,
} from './env';
import { RUN_KINDS, statsTarget } from './stats';

describe('filter env (#445 amendment 5)', () => {
  it('mirrors the shared contract the hot path does not load', () => {
    expect(RAW_ENV).toBe(TOKEN_SAVER_RAW_ENV);
    expect(FILTER_NONE).toBe(FILTER_ID_NONE);
    expect([...RUN_KINDS]).toEqual([...TOKEN_SAVER_RUN_KINDS]);
  });

  it('gives a run launch its stats file, project, run and kind', () => {
    expect(
      filterEnv({
        runDir: '/state/cards/c1',
        projectId: 'p1',
        runId: 'r1',
        runKind: 'card',
      }),
    ).toEqual({
      [FILTER_STATS_ENV]: '/state/cards/c1/filter-stats.jsonl',
      [FILTER_PROJECT_ENV]: 'p1',
      [FILTER_RUN_ENV]: 'r1',
      [FILTER_RUN_KIND_ENV]: 'card',
    });
  });

  it('leaves the run out for the orchestrator, and reads back what it wrote', () => {
    const runDir = orchestratorFilterDir('/state', 'AndreyBegma/AgentDock');
    expect(runDir).toBe('/state/orchestrator/AndreyBegma__AgentDock');
    const env = filterEnv({
      runDir,
      projectId: 'p1',
      runId: null,
      runKind: 'orchestrator',
    });
    expect(env[FILTER_RUN_ENV]).toBeUndefined();
    expect(statsTarget(env)).toEqual({
      file: `${runDir}/filter-stats.jsonl`,
      projectId: 'p1',
      runId: null,
      runKind: 'orchestrator',
    });
  });

  it('keeps a repository name from climbing out of the state dir', () => {
    for (const repo of ['../../etc', '..', 'a/../../b']) {
      const dir = orchestratorFilterDir('/state', repo);
      expect(dir.startsWith('/state/orchestrator/')).toBe(true);
      const name = dir.slice('/state/orchestrator/'.length);
      expect(name).not.toContain('/');
      expect(name.startsWith('.')).toBe(false);
    }
  });

  it('has no target when the env is missing or inconsistent', () => {
    const ok = filterEnv({
      runDir: '/r',
      projectId: 'p',
      runId: 'r1',
      runKind: 'card',
    });
    expect(statsTarget({})).toBeNull();
    for (const broken of [
      { [FILTER_STATS_ENV]: 'relative.jsonl' },
      { [FILTER_RUN_KIND_ENV]: 'schedule' },
      { [FILTER_RUN_KIND_ENV]: 'orchestrator' },
    ]) {
      expect(statsTarget({ ...ok, ...broken })).toBeNull();
    }
    expect(statsTarget({ ...ok, [FILTER_PROJECT_ENV]: '' })).toBeNull();
  });

  it('takes a manual (/cs-eco) session with or without a run (#475)', () => {
    const env = {
      [FILTER_STATS_ENV]: '/eco/sessions/s1/filter-stats.jsonl',
      [FILTER_PROJECT_ENV]: 'AndreyBegma/AgentDock',
      [FILTER_RUN_KIND_ENV]: 'manual',
    };
    expect(statsTarget(env)?.runId).toBeNull();
    expect(statsTarget({ ...env, [FILTER_RUN_ENV]: 's1' })?.runId).toBe('s1');
  });
});
