import { describe, expect, it } from 'bun:test';
import {
  FILTER_ID_NONE,
  TOKEN_ECONOMY_TECHNIQUES,
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
  TECHNIQUE_CACHE_TTL_1H,
  TECHNIQUE_GREP_CUT,
  TECHNIQUE_MCP_CUT,
  TECHNIQUE_READ_GUARD_400,
  TECHNIQUE_TERSE_REGISTER,
  TECHNIQUE_WEBFETCH_CUT,
  TECHNIQUES_ENV,
  techniqueOn,
  techniquesEnv,
  techniquesFrom,
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
    const runDir = orchestratorFilterDir('/state', 'AndreyBegma/Nautelle');
    expect(runDir).toBe('/state/orchestrator/AndreyBegma__Nautelle');
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
      [FILTER_PROJECT_ENV]: 'AndreyBegma/Nautelle',
      [FILTER_RUN_KIND_ENV]: 'manual',
    };
    expect(statsTarget(env)?.runId).toBeNull();
    expect(statsTarget({ ...env, [FILTER_RUN_ENV]: 's1' })?.runId).toBe('s1');
  });
});

describe('technique flags (#747 D4)', () => {
  it('mirrors the registered runner techniques the hot path does not load', () => {
    const registered = TOKEN_ECONOMY_TECHNIQUES.map((t) => t.key);
    for (const key of [
      TECHNIQUE_MCP_CUT,
      TECHNIQUE_GREP_CUT,
      TECHNIQUE_WEBFETCH_CUT,
      TECHNIQUE_READ_GUARD_400,
      TECHNIQUE_TERSE_REGISTER,
      TECHNIQUE_CACHE_TTL_1H,
    ]) {
      expect(registered).toContain(key);
    }
  });

  it('sets nothing when no technique is on — the launch is as before', () => {
    expect(techniquesEnv(undefined)).toEqual({});
    expect(techniquesEnv({})).toEqual({});
    expect(techniquesEnv({ 'mcp-cut': false })).toEqual({});
  });

  it('lists exactly the keys that are on', () => {
    expect(
      techniquesEnv({
        'mcp-cut': true,
        'grep-cut': false,
        'read-guard-400': true,
      }),
    ).toEqual({ [TECHNIQUES_ENV]: 'mcp-cut,read-guard-400' });
  });

  it('reads back what the launch set, and unset as none', () => {
    const env = techniquesEnv({ 'mcp-cut': true, 'read-guard-400': true });
    expect([...techniquesFrom(env)]).toEqual(['mcp-cut', 'read-guard-400']);
    expect(techniqueOn(env, TECHNIQUE_MCP_CUT)).toBe(true);
    expect(techniqueOn(env, TECHNIQUE_GREP_CUT)).toBe(false);
    expect(techniquesFrom({}).size).toBe(0);
    expect([
      ...techniquesFrom({ [TECHNIQUES_ENV]: ' mcp-cut, ,grep-cut ' }),
    ]).toEqual(['mcp-cut', 'grep-cut']);
  });
});
