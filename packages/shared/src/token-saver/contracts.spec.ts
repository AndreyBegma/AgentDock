import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type CommandName,
  capabilitiesSchema,
  commands,
  eventsMessageSchema,
  localCardFinishArgsSchema,
  PROFILE_MCP_SERVERS_MAX,
  runtimeProfileSchema,
  tokenSaverAvailable,
} from '../protocol';
import {
  FILTER_STATS_EVENT,
  FILTER_STATS_MAX_ROWS,
  type FilterStatRow,
  filterStatRowSchema,
  filterStatsDataSchema,
  TOKEN_SAVER_DEFAULT,
  TOKEN_SAVER_MCP_ALLOW_MAX,
  tokenSaverConfigSchema,
} from './contracts';
import { estimateTokensSaved, estimateUsdSaved } from './estimate';

const row: FilterStatRow = {
  id: 'r1',
  runId: 'cmrun0001',
  runKind: 'card',
  filter: 'js/jest',
  rawBytes: 40_000,
  keptBytes: 3_000,
  bypassed: false,
  passedThrough: false,
  at: '2026-10-16T12:00:00.000Z',
};

describe('tokenSaverConfigSchema (#445 D6, D11)', () => {
  it('accepts the default and an allowlist', () => {
    expect(tokenSaverConfigSchema.safeParse(TOKEN_SAVER_DEFAULT).success).toBe(
      true,
    );
    expect(
      tokenSaverConfigSchema.safeParse({
        enabled: true,
        mcpAllow: ['playwright', 'glitch_tip.v2'],
      }).success,
    ).toBe(true);
  });

  it('rejects duplicates, bad names, too many servers and unknown keys', () => {
    const bad = [
      { enabled: true, mcpAllow: ['playwright', 'playwright'] },
      { enabled: true, mcpAllow: ['-flag'] },
      { enabled: true, mcpAllow: ['a b'] },
      {
        enabled: true,
        mcpAllow: Array.from(
          { length: TOKEN_SAVER_MCP_ALLOW_MAX + 1 },
          (_, i) => `s${i}`,
        ),
      },
      { enabled: true, mcpAllow: [], extra: 1 },
    ];
    for (const value of bad) {
      expect(tokenSaverConfigSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('tokenSaver on the eight launch commands (#445 D1)', () => {
  const launches: CommandName[] = [
    'card.run',
    'skill.run',
    'plan.turn',
    'card.assess',
    'cards.extract',
    'uiprofile.build',
    'text.normalize',
    'orchestrator.start',
  ];

  it.each(launches)('%s takes an optional tokenSaver', (name) => {
    const args = commands[name].args;
    expect(args).toBeInstanceOf(z.ZodObject);
    const field = (args as z.ZodObject).shape.tokenSaver;
    expect(field).toBeDefined();
    expect(field?.safeParse(undefined).success).toBe(true);
    expect(field?.safeParse({ enabled: false, mcpAllow: [] }).success).toBe(
      true,
    );
    expect(field?.safeParse({ enabled: 'yes', mcpAllow: [] }).success).toBe(
      false,
    );
  });
});

describe('tokenSaver capability (#445)', () => {
  const base = {
    tmux: null,
    git: null,
    gh: null,
    runtimes: { claude: null, codex: null },
    profiles: [],
    codeSentinel: null,
    otlp: null,
  };

  it('is false when absent — a runner older than the feature', () => {
    const caps = capabilitiesSchema.parse(base);
    expect(tokenSaverAvailable(caps)).toBe(false);
  });

  it('is true only when the runner says so', () => {
    expect(
      tokenSaverAvailable(
        capabilitiesSchema.parse({ ...base, tokenSaver: true }),
      ),
    ).toBe(true);
  });
});

describe('profile mcpServers (#445 D6)', () => {
  const profile = {
    id: 'default',
    runtime: 'claude',
    env: {},
    args: [],
    authenticated: true,
  };

  it('is optional — absent means unknown', () => {
    const parsed = runtimeProfileSchema.parse(profile);
    expect(parsed.mcpServers).toBeUndefined();
  });

  it('takes server names', () => {
    expect(
      runtimeProfileSchema.parse({
        ...profile,
        mcpServers: ['playwright', 'agentdock', 'my_server.v2'],
      }).mcpServers,
    ).toEqual(['playwright', 'agentdock', 'my_server.v2']);
  });

  it('rejects anything that is not a bare name', () => {
    for (const name of ['', '-x', 'npx foo', 'a/b', 'x'.repeat(65)]) {
      expect(
        runtimeProfileSchema.safeParse({ ...profile, mcpServers: [name] })
          .success,
      ).toBe(false);
    }
    expect(
      runtimeProfileSchema.safeParse({
        ...profile,
        mcpServers: [{ name: 'x', command: 'npx' }],
      }).success,
    ).toBe(false);
  });

  it(`holds at most ${PROFILE_MCP_SERVERS_MAX} names`, () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
    expect(
      runtimeProfileSchema.safeParse({
        ...profile,
        mcpServers: names(PROFILE_MCP_SERVERS_MAX),
      }).success,
    ).toBe(true);
    expect(
      runtimeProfileSchema.safeParse({
        ...profile,
        mcpServers: names(PROFILE_MCP_SERVERS_MAX + 1),
      }).success,
    ).toBe(false);
  });
});

describe('card.finish artifactIncomplete (#445 D8)', () => {
  it('is optional and boolean', () => {
    expect(
      localCardFinishArgsSchema.safeParse({ summary: 'Done.' }).success,
    ).toBe(true);
    expect(
      localCardFinishArgsSchema.safeParse({
        summary: 'Done.',
        artifactIncomplete: true,
      }).success,
    ).toBe(true);
    expect(
      localCardFinishArgsSchema.safeParse({
        summary: 'Done.',
        artifactIncomplete: 'yes',
      }).success,
    ).toBe(false);
  });
});

describe('filter.stats rows (#445 D12)', () => {
  it('accepts a filtered, a bypassed and a passed-through command', () => {
    expect(filterStatRowSchema.safeParse(row).success).toBe(true);
    expect(
      filterStatRowSchema.safeParse({
        ...row,
        keptBytes: row.rawBytes,
        bypassed: true,
      }).success,
    ).toBe(true);
    expect(
      filterStatRowSchema.safeParse({
        ...row,
        filter: 'none',
        keptBytes: row.rawBytes,
        passedThrough: true,
      }).success,
    ).toBe(true);
  });

  it('accepts the orchestrator and manual sessions without a run', () => {
    for (const runKind of ['orchestrator', 'manual']) {
      expect(
        filterStatRowSchema.safeParse({ ...row, runId: null, runKind }).success,
      ).toBe(true);
    }
  });

  it('rejects impossible byte counts', () => {
    expect(
      filterStatRowSchema.safeParse({ ...row, keptBytes: row.rawBytes + 1 })
        .success,
    ).toBe(false);
    expect(
      filterStatRowSchema.safeParse({ ...row, bypassed: true }).success,
    ).toBe(false);
    expect(
      filterStatRowSchema.safeParse({ ...row, passedThrough: true }).success,
    ).toBe(false);
    expect(
      filterStatRowSchema.safeParse({ ...row, rawBytes: -1 }).success,
    ).toBe(false);
  });

  it('ties a null runId to the orchestrator and manual sessions', () => {
    expect(filterStatRowSchema.safeParse({ ...row, runId: null }).success).toBe(
      false,
    );
    for (const runKind of ['orchestrator', 'manual']) {
      expect(filterStatRowSchema.safeParse({ ...row, runKind }).success).toBe(
        false,
      );
    }
  });

  it('rejects a malformed filter id, an unknown run kind and a projectId', () => {
    for (const filter of ['JS/jest', 'js/', '/jest', 'a/b/c', '']) {
      expect(filterStatRowSchema.safeParse({ ...row, filter }).success).toBe(
        false,
      );
    }
    expect(
      filterStatRowSchema.safeParse({ ...row, runKind: 'schedule' }).success,
    ).toBe(false);
    expect(
      filterStatRowSchema.safeParse({ ...row, projectId: 'p1' }).success,
    ).toBe(false);
  });

  it('parses the runner-protocol.md example', () => {
    const markdown = readFileSync(
      join(__dirname, '../../../../docs/architecture/runner-protocol.md'),
      'utf8',
    );
    const event = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => eventsMessageSchema.safeParse(JSON.parse(m[1])))
      .flatMap((r) => (r.success ? r.data.events : []))
      .find((e) => e.type === FILTER_STATS_EVENT);
    expect(event?.source).toBe('runner');
    expect(filterStatsDataSchema.safeParse(event?.data).success).toBe(true);
  });

  it('bounds a batch to 1…FILTER_STATS_MAX_ROWS rows', () => {
    expect(filterStatsDataSchema.safeParse({ rows: [row] }).success).toBe(true);
    expect(filterStatsDataSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(
      filterStatsDataSchema.safeParse({
        rows: Array.from({ length: FILTER_STATS_MAX_ROWS + 1 }, (_, i) => ({
          ...row,
          id: `r${i}`,
        })),
      }).success,
    ).toBe(false);
  });
});

describe('the estimate (#445 D12)', () => {
  it('is bytes / 4, rounded, never negative', () => {
    expect(estimateTokensSaved(40_000, 3_000)).toBe(9_250);
    expect(estimateTokensSaved(10, 10)).toBe(0);
    expect(estimateTokensSaved(3, 5)).toBe(0);
  });

  it('prices tokens at a per-token input price', () => {
    expect(estimateUsdSaved(1_000_000, '0.000003')).toBeCloseTo(3, 10);
    expect(estimateUsdSaved(1_000, 'not a number')).toBe(0);
    expect(estimateUsdSaved(1_000, '-1')).toBe(0);
  });
});
