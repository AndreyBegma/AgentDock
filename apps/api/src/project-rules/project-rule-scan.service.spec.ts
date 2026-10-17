import type {
  ProjectRuleImportResult,
  ProjectRuleView,
} from '@agentdock/shared';
import { HttpException } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import type { PrismaService } from '../database/prisma.service';
import type { ProjectInspector } from '../projects';
import type { TextNormalizer } from '../text';
import { ProjectRuleScanService } from './project-rule-scan.service';
import type { ProjectRulesService } from './project-rules.service';

const ctx: AuditContext = { actor: { type: 'user', userId: 'usr_admin' } };

const rule = (
  id: string,
  title: string,
  description = '',
): ProjectRuleView => ({
  id,
  projectId: 'prj_a',
  title,
  description,
  enabled: true,
  position: 0,
  source: 'scanned',
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
});

const scanResult = {
  candidates: [
    { title: 'Use Bun', description: 'Never npm.', source: 'CLAUDE.md' },
    { title: 'Format with Biome', description: '', source: 'biome.json' },
  ],
  scanned: ['CLAUDE.md', 'biome.json'],
  warnings: ['AGENTS.md is larger than 256 KB; skipped.'],
};

const setup = () => {
  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'prj_a'
          ? { runnerId: 'run_1', rootPath: '/srv/billing' }
          : null,
      ),
    },
  };
  const inspector = { scanRules: jest.fn(async () => scanResult) };
  const rules = {
    takenTitleKeys: jest.fn(async () => new Set(['use bun'])),
    addScanned: jest.fn(
      async (): Promise<ProjectRuleImportResult> => ({
        created: 2,
        skipped: 0,
        rules: [
          rule('r1', 'Используй Bun', 'Никогда npm.'),
          rule('r2', 'Biome'),
        ],
        skippedTitles: [],
      }),
    ),
    list: jest.fn(async () => [rule('r1', 'Use Bun', 'Never npm.')]),
  };
  const text = { request: jest.fn(async () => 'txt_1') };
  const service = new ProjectRuleScanService(
    prisma as unknown as PrismaService,
    inspector as unknown as ProjectInspector,
    rules as unknown as ProjectRulesService,
    text as unknown as TextNormalizer,
  );
  return { service, prisma, inspector, rules, text };
};

describe('ProjectRuleScanService (#584)', () => {
  it('scans a path before connect: nothing is a duplicate', async () => {
    const { service, inspector, rules } = setup();

    const result = await service.scanPath('run_1', '/srv/billing', ctx);

    expect(inspector.scanRules).toHaveBeenCalledWith(
      'run_1',
      '/srv/billing',
      ctx,
    );
    expect(result.candidates.map((c) => c.duplicate)).toEqual([false, false]);
    expect(result.warnings).toEqual(scanResult.warnings);
    expect(rules.takenTitleKeys).not.toHaveBeenCalled();
  });

  it("rescans the project's root on its runner and marks taken titles", async () => {
    const { service, inspector } = setup();

    const result = await service.scan('prj_a', ctx);

    expect(inspector.scanRules).toHaveBeenCalledWith(
      'run_1',
      '/srv/billing',
      ctx,
    );
    expect(result.candidates).toEqual([
      { ...scanResult.candidates[0], duplicate: true },
      { ...scanResult.candidates[1], duplicate: false },
    ]);
  });

  it('answers 404 for a project that does not exist', async () => {
    const { service, inspector } = setup();
    const error = await service.scan('prj_gone', ctx).catch((e) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
    expect(inspector.scanRules).not.toHaveBeenCalled();
  });

  it('creates the accepted rules, then requests their English text', async () => {
    const { service, rules, text } = setup();
    const accepted = [scanResult.candidates[0]];

    const result = await service.accept('prj_a', accepted, 'usr_admin', ctx);

    expect(rules.addScanned).toHaveBeenCalledWith('prj_a', accepted, ctx);
    expect(text.request).toHaveBeenCalledWith(
      'prj_a',
      { ownerType: 'project_rule', ownerId: 'r1' },
      [
        { field: 'title', text: 'Используй Bun' },
        { field: 'description', text: 'Никогда npm.' },
      ],
      { authorId: 'usr_admin' },
    );
    expect(text.request).toHaveBeenCalledTimes(2);
    // The rules as they are after the request: translated when DeepL answered.
    expect(result.rules.map((r) => r.title)).toEqual(['Use Bun', 'Biome']);
  });

  it('requests nothing when every candidate was taken', async () => {
    const { service, rules, text } = setup();
    rules.addScanned.mockResolvedValueOnce({
      created: 0,
      skipped: 1,
      rules: [],
      skippedTitles: ['Use Bun'],
    });

    await service.accept('prj_a', [scanResult.candidates[0]], null, ctx);

    expect(text.request).not.toHaveBeenCalled();
    expect(rules.list).not.toHaveBeenCalled();
  });
});
