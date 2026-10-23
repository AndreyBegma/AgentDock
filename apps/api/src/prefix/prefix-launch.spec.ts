import type { Capabilities } from '@nautelle/shared/protocol';
import type { PrismaService } from '../database/prisma.service';
import { capabilities as runnerCapabilities } from '../runners/testing/runner-e2e';
import { PrefixLaunchService } from './prefix-launch';
import { rulesVersionOf } from './rules-version';

const SHA = 'b'.repeat(64);

type Rule = {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  appliesTo: string[];
};

type Overlay = {
  id: string;
  part: string;
  state: string;
  originalSha256: string;
  content: string;
  rulesVersion: string | null;
  createdAt: Date;
};

/** A project's rules, settings, overlays and the card's design, in memory. */
const world = () => {
  const state = {
    rules: [
      {
        id: 'r1',
        title: 'All',
        description: 'Always.',
        enabled: true,
        appliesTo: [],
      },
      {
        id: 'r2',
        title: 'Bugs',
        description: 'Bugs only.',
        enabled: true,
        appliesTo: ['bug'],
      },
      {
        id: 'r3',
        title: 'UI',
        description: 'UI only.',
        enabled: true,
        appliesTo: ['ui'],
      },
    ] as Rule[],
    settings: {
      mcpByType: { bug: ['github'] } as unknown,
      skillsOffByType: { bug: ['cs-seo'] } as unknown,
    },
    overlays: [] as Overlay[],
    design: null as {
      status: string;
      approvedRevisionId: string | null;
    } | null,
  };
  const matches = (o: Overlay, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const value = o[k as keyof Overlay];
      if (v && typeof v === 'object' && 'not' in v) return value !== v.not;
      if (v && typeof v === 'object' && 'in' in v) {
        return (v.in as unknown[]).includes(value);
      }
      return value === v;
    });
  const prisma = {
    projectRule: {
      findMany: jest.fn(async () => state.rules.filter((r) => r.enabled)),
    },
    tokenSaverSettings: { findUnique: jest.fn(async () => state.settings) },
    taskDesign: { findUnique: jest.fn(async () => state.design) },
    prefixOverlay: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          state.overlays.find((o) => matches(o, stripProject(where))) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.overlays.filter((o) => matches(o, stripProject(where))),
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          state.overlays.find((o) => o.id === where.id) ?? null,
      ),
    },
  };
  return {
    state,
    service: new PrefixLaunchService(prisma as unknown as PrismaService),
  };
};

const stripProject = (where: Record<string, unknown>) => {
  const { projectId: _projectId, ...rest } = where;
  return rest;
};

const capabilities: Capabilities = {
  ...runnerCapabilities,
  tokenSaver: true,
  prefixOverlays: true,
};

const input = (
  over: Partial<Parameters<PrefixLaunchService['resolve']>[0]> = {},
) => ({
  projectId: 'prj',
  card: { id: 'card_1', kind: 'bug' as const, sessionPrefix: null },
  ciFix: false,
  reuse: false,
  flags: {},
  mcpAllow: ['github', 'linear'],
  capabilities,
  ...over,
});

describe('the card launch prefix (#751 S2, B4–B7)', () => {
  it('in the A arm sends every rule, every allowed server and no hidden skill', async () => {
    const { service } = world();
    const launch = await service.resolve(input());
    expect(launch.cardType).toBe('bug');
    expect(launch.projectRules).toContain('All');
    expect(launch.projectRules).toContain('Bugs');
    expect(launch.projectRules).toContain('UI');
    expect(launch.prefix).toEqual({
      cardType: 'bug',
      skillsOff: [],
      overlays: [],
    });
  });

  it('in the prefix-select B arm narrows rules, servers and skills to the bug type', async () => {
    const { service } = world();
    const launch = await service.resolve(
      input({ flags: { 'prefix-select': true } }),
    );
    expect(launch.projectRules).toContain('All');
    expect(launch.projectRules).toContain('Bugs');
    expect(launch.projectRules).not.toContain('UI only.');
    expect(launch.prefix).toEqual({
      cardType: 'bug',
      mcpAllow: ['github'],
      skillsOff: ['cs-seo'],
      overlays: [],
    });
  });

  it('never widens mcpAllow with a per-type server', async () => {
    const { service, state } = world();
    state.settings.mcpByType = { bug: ['github', 'figma'] };
    const launch = await service.resolve(
      input({ flags: { 'prefix-select': true } }),
    );
    expect(launch.prefix?.mcpAllow).toEqual(['github']);
  });

  it('a resumed round reuses the frozen selection after the settings change', async () => {
    const { service, state } = world();
    const first = await service.resolve(
      input({ flags: { 'prefix-select': true } }),
    );
    state.settings.mcpByType = { bug: ['linear'] };
    state.settings.skillsOffByType = {};
    const resumed = await service.resolve(
      input({
        flags: { 'prefix-select': true },
        reuse: true,
        card: { id: 'card_1', kind: 'bug', sessionPrefix: first.session },
      }),
    );
    expect(resumed.started).toBe(false);
    expect(resumed.projectRules).toBeNull();
    expect(resumed.prefix?.mcpAllow).toEqual(['github']);
    expect(resumed.prefix?.skillsOff).toEqual(['cs-seo']);
    const fresh = await service.resolve(
      input({ flags: { 'prefix-select': true } }),
    );
    expect(fresh.prefix?.mcpAllow).toEqual(['linear']);
  });

  it('types a card with an approved design ui, and a CI fix ci_fix', async () => {
    const { service, state } = world();
    state.design = { status: 'approved', approvedRevisionId: 'rev' };
    expect((await service.resolve(input())).cardType).toBe('ui');
    expect((await service.resolve(input({ ciFix: true }))).cardType).toBe(
      'ci_fix',
    );
  });

  it('uses the compressed rules only in the B arm, only once approved, only for the current version', async () => {
    const { service, state } = world();
    const version = rulesVersionOf(state.rules);
    const compressed = {
      id: 'ov_rules',
      part: 'rules',
      state: 'proposed',
      originalSha256: SHA,
      rulesVersion: version,
      createdAt: new Date(),
      content: JSON.stringify({
        rules: [
          { id: 'r1', title: 'All', description: 'Short.' },
          { id: 'r2', title: 'Bugs', description: 'Short bug.' },
          { id: 'r3', title: 'UI', description: 'Short ui.' },
        ],
      }),
    };
    state.overlays.push(compressed);
    const b = input({ flags: { 'rules-compressed': true } });
    expect((await service.resolve(b)).projectRules).toContain('Always.');
    compressed.state = 'approved';
    expect((await service.resolve(b)).projectRules).toContain('Short.');
    expect((await service.resolve(input())).projectRules).toContain('Always.');
    state.rules[0] = { ...state.rules[0], description: 'Changed.' } as Rule;
    const changed = await service.resolve(b);
    expect(changed.projectRules).toContain('Changed.');
    expect(changed.projectRules).not.toContain('Short.');
  });

  it('sends approved file overlays in the prefix-overlays B arm, never a stale one', async () => {
    const { service, state } = world();
    state.overlays.push({
      id: 'ov_md',
      part: 'claude_md',
      state: 'approved',
      originalSha256: SHA,
      content: '# short',
      rulesVersion: null,
      createdAt: new Date(),
    });
    const a = await service.resolve(input());
    expect(a.prefix?.overlays).toEqual([]);
    const b = await service.resolve(
      input({ flags: { 'prefix-overlays': true } }),
    );
    expect(b.prefix?.overlays).toEqual([
      {
        id: 'ov_md',
        part: 'claude_md',
        originalSha256: SHA,
        content: '# short',
      },
    ]);
    state.overlays[0] = { ...state.overlays[0], state: 'stale' } as Overlay;
    const resumed = await service.resolve(
      input({
        flags: { 'prefix-overlays': true },
        reuse: true,
        card: { id: 'card_1', kind: 'bug', sessionPrefix: b.session },
      }),
    );
    expect(resumed.prefix?.overlays).toEqual([]);
  });

  it('sends no prefix to a runner without prefixOverlays', async () => {
    const { service } = world();
    const launch = await service.resolve(
      input({ capabilities: { ...runnerCapabilities, tokenSaver: true } }),
    );
    expect(launch.prefix).toBeNull();
    expect(launch.projectRules).toContain('All');
  });
});
