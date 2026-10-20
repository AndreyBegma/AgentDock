import { textSourceHash } from '@nautelle/shared';
import type { HttpException } from '@nestjs/common';
import type { ProjectRule } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import type { PrismaService } from '../database/prisma.service';
import { ProjectRulesService } from './project-rules.service';

const A = 'prj_a';
const B = 'prj_b';
const ctx: AuditContext = { actor: { type: 'user', userId: 'usr_admin' } };

type Where = { id?: string; projectId?: string; position?: { gt: number } };

/** An in-memory `projectRule` table, enough for the service. */
const fakePrisma = () => {
  let rows: ProjectRule[] = [];
  let seq = 0;
  let clock = Date.parse('2026-10-17T10:00:00.000Z');
  const tick = () => {
    clock += 1000;
    return new Date(clock);
  };
  const matches = (row: ProjectRule, where: Where) =>
    (where.id === undefined || row.id === where.id) &&
    (where.projectId === undefined || row.projectId === where.projectId) &&
    (where.position === undefined || row.position > where.position.gt);
  const sorted = (list: ProjectRule[]) =>
    [...list].sort(
      (x, y) =>
        x.position - y.position ||
        x.createdAt.getTime() - y.createdAt.getTime(),
    );

  const projectRule = {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      sorted(rows.filter((r) => matches(r, where))),
    ),
    findFirst: jest.fn(
      async ({ where }: { where: Where }) =>
        rows.find((r) => matches(r, where)) ?? null,
    ),
    aggregate: jest.fn(async ({ where }: { where: Where }) => {
      const positions = rows
        .filter((r) => matches(r, where))
        .map((r) => r.position);
      return {
        _max: { position: positions.length ? Math.max(...positions) : null },
      };
    }),
    create: jest.fn(async ({ data }: { data: Partial<ProjectRule> }) => {
      const at = tick();
      const row: ProjectRule = {
        id: `rule_${++seq}`,
        projectId: data.projectId ?? '',
        title: data.title ?? '',
        description: data.description ?? '',
        enabled: data.enabled ?? true,
        position: data.position ?? 0,
        source: data.source ?? 'manual',
        createdAt: at,
        updatedAt: at,
      };
      rows.push(row);
      return row;
    }),
    update: jest.fn(
      async ({ where, data }: { where: Where; data: Partial<ProjectRule> }) => {
        const index = rows.findIndex((r) => matches(r, where));
        rows[index] = { ...rows[index], ...data, updatedAt: tick() };
        return rows[index];
      },
    ),
    delete: jest.fn(async ({ where }: { where: Where }) => {
      const row = rows.find((r) => matches(r, where));
      rows = rows.filter((r) => r !== row);
      return row;
    }),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Where;
        data: { position: { decrement: number } };
      }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) r.position -= data.position.decrement;
        return { count: hit.length };
      },
    ),
  };
  /** `project_rule` normalization rows: their project and title originals. */
  const normalizations: { projectId: string; fields: unknown }[] = [];
  const textNormalization = {
    findMany: jest.fn(async ({ where }: { where: { projectId: string } }) =>
      normalizations.filter((n) => n.projectId === where.projectId),
    ),
  };
  const prisma = {
    projectRule,
    textNormalization,
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma, rows: () => sorted(rows), normalizations };
};

const setup = () => {
  const db = fakePrisma();
  const audit = { record: jest.fn(async () => undefined) };
  const service = new ProjectRulesService(
    db.prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, audit, db };
};

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error('expected a rejection');
};

describe('ProjectRulesService (#528)', () => {
  describe('create and list', () => {
    it('appends enabled manual rules and lists them by position', async () => {
      const { service } = setup();
      const first = await service.create(A, { title: 'Use Bun' }, ctx);
      await service.create(
        A,
        { title: 'Biome only', description: 'No ESLint', enabled: false },
        ctx,
      );
      await service.create(B, { title: 'Other project' }, ctx);

      expect(first).toMatchObject({
        projectId: A,
        title: 'Use Bun',
        description: '',
        enabled: true,
        position: 0,
        source: 'manual',
      });
      expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
      const list = await service.list(A);
      expect(
        list.map((r) => [r.title, r.position, r.enabled, r.description]),
      ).toEqual([
        ['Use Bun', 0, true, ''],
        ['Biome only', 1, false, 'No ESLint'],
      ]);
    });

    it('audits a create as a project update', async () => {
      const { service, audit } = setup();
      const rule = await service.create(A, { title: 'Use Bun' }, ctx);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: ctx.actor,
          action: 'project.update',
          target: { type: 'project', id: A },
          projectId: A,
          after: { rule: expect.objectContaining({ id: rule.id }) },
          meta: { rules: 'create' },
          result: 'ok',
        }),
      );
    });
  });

  describe('update', () => {
    it('changes only the fields given', async () => {
      const { service } = setup();
      const rule = await service.create(
        A,
        { title: 'Use Bun', description: 'Pinned' },
        ctx,
      );

      const off = await service.update(A, rule.id, { enabled: false }, ctx);
      expect(off).toMatchObject({
        title: 'Use Bun',
        description: 'Pinned',
        enabled: false,
      });
      const renamed = await service.update(
        A,
        rule.id,
        { title: 'Bun only', description: '' },
        ctx,
      );
      expect(renamed).toMatchObject({
        title: 'Bun only',
        description: '',
        enabled: false,
      });
    });

    it("is 404 for an unknown rule or another project's rule", async () => {
      const { service } = setup();
      const ofB = await service.create(B, { title: 'B rule' }, ctx);

      for (const id of ['rule_missing', ofB.id]) {
        expect(
          await rejection(service.update(A, id, { enabled: false }, ctx)),
        ).toEqual({
          status: 404,
          body: {
            statusCode: 404,
            error: 'not_found',
            message: 'Rule not found',
          },
        });
      }
      expect((await service.list(B))[0].enabled).toBe(true);
    });
  });

  describe('remove', () => {
    it('deletes the rule and closes the gap in positions', async () => {
      const { service } = setup();
      const [x, y, z] = [
        await service.create(A, { title: 'X' }, ctx),
        await service.create(A, { title: 'Y' }, ctx),
        await service.create(A, { title: 'Z' }, ctx),
      ];
      await service.remove(A, x.id, ctx);

      expect((await service.list(A)).map((r) => [r.id, r.position])).toEqual([
        [y.id, 0],
        [z.id, 1],
      ]);
      expect((await service.create(A, { title: 'W' }, ctx)).position).toBe(2);
    });

    it("is 404 for another project's rule and leaves it", async () => {
      const { service } = setup();
      const ofB = await service.create(B, { title: 'B rule' }, ctx);

      expect((await rejection(service.remove(A, ofB.id, ctx))).status).toBe(
        404,
      );
      expect(await service.list(B)).toHaveLength(1);
    });
  });

  describe('reorder', () => {
    it('rewrites positions in the given order', async () => {
      const { service, audit } = setup();
      const [x, y, z] = [
        await service.create(A, { title: 'X' }, ctx),
        await service.create(A, { title: 'Y' }, ctx),
        await service.create(A, { title: 'Z' }, ctx),
      ];

      const list = await service.reorder(A, [z.id, x.id, y.id], ctx);
      expect(list.map((r) => [r.title, r.position])).toEqual([
        ['Z', 0],
        ['X', 1],
        ['Y', 2],
      ]);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          before: { ruleOrder: [x.id, y.id, z.id] },
          after: { ruleOrder: [z.id, x.id, y.id] },
          meta: { rules: 'reorder' },
        }),
      );
    });

    it('is 409 unless every rule of the project is listed exactly once', async () => {
      const { service } = setup();
      const x = await service.create(A, { title: 'X' }, ctx);
      const y = await service.create(A, { title: 'Y' }, ctx);
      const ofB = await service.create(B, { title: 'B' }, ctx);

      for (const ids of [
        [x.id],
        [x.id, x.id],
        [x.id, y.id, ofB.id],
        [x.id, ofB.id],
        [],
      ]) {
        expect(await rejection(service.reorder(A, ids, ctx))).toEqual({
          status: 409,
          body: expect.objectContaining({ error: 'rule_order_mismatch' }),
        });
      }
      expect((await service.list(A)).map((r) => r.id)).toEqual([x.id, y.id]);
    });

    it('accepts an empty order for a project without rules', async () => {
      const { service } = setup();
      expect(await service.reorder(A, [], ctx)).toEqual([]);
    });
  });

  describe('import', () => {
    it('creates one enabled imported rule per section, after the existing ones', async () => {
      const { service } = setup();
      await service.create(A, { title: 'Existing', enabled: false }, ctx);

      const result = await service.import(
        A,
        '## Use Bun\nNever npm.\n## Biome only\nNo ESLint.\n',
        ctx,
      );
      expect(result).toMatchObject({
        created: 2,
        skipped: 0,
        skippedTitles: [],
      });
      expect(
        (await service.list(A)).map((r) => [
          r.title,
          r.description,
          r.enabled,
          r.position,
          r.source,
        ]),
      ).toEqual([
        ['Existing', '', false, 0, 'manual'],
        ['Use Bun', 'Never npm.', true, 1, 'imported'],
        ['Biome only', 'No ESLint.', true, 2, 'imported'],
      ]);
      expect(result.rules.map((r) => r.title)).toEqual([
        'Use Bun',
        'Biome only',
      ]);
    });

    it('skips titles already on the project or repeated in the document', async () => {
      const { service } = setup();
      await service.create(A, { title: 'Use Bun' }, ctx);
      await service.create(B, { title: 'Biome only' }, ctx);

      const result = await service.import(
        A,
        '- use bun\n- Biome only\n- Strict TS\n- strict  ts\n',
        ctx,
      );
      expect(result).toMatchObject({
        created: 2,
        skipped: 2,
        skippedTitles: ['use bun', 'strict ts'],
      });
      expect((await service.list(A)).map((r) => r.title)).toEqual([
        'Use Bun',
        'Biome only',
        'Strict TS',
      ]);
    });

    it('is idempotent: importing the same document twice creates nothing new', async () => {
      const { service, audit } = setup();
      const markdown = '## A\na\n## B\nb\n';
      await service.import(A, markdown, ctx);
      audit.record.mockClear();

      expect(await service.import(A, markdown, ctx)).toEqual({
        created: 0,
        skipped: 2,
        rules: [],
        skippedTitles: ['A', 'B'],
      });
      expect(await service.list(A)).toHaveLength(2);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('creates nothing from a document without rules', async () => {
      const { service, db } = setup();
      expect(await service.import(A, '', ctx)).toEqual({
        created: 0,
        skipped: 0,
        rules: [],
        skippedTitles: [],
      });
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('addScanned (#584)', () => {
    const scanned = (title: string, description = '') => ({
      title,
      description,
      source: 'CLAUDE.md',
    });

    it('appends the accepted candidates as enabled scanned rules, in order', async () => {
      const { service, audit } = setup();
      await service.create(A, { title: 'Existing', enabled: false }, ctx);

      const result = await service.addScanned(
        A,
        [scanned('Use Bun', 'Never npm.'), scanned('Biome only')],
        ctx,
      );

      expect(result).toMatchObject({ created: 2, skipped: 0 });
      expect(
        (await service.list(A)).map((r) => [
          r.title,
          r.enabled,
          r.position,
          r.source,
        ]),
      ).toEqual([
        ['Existing', false, 0, 'manual'],
        ['Use Bun', true, 1, 'scanned'],
        ['Biome only', true, 2, 'scanned'],
      ]);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'project.update',
          meta: { rules: 'scan', skipped: 0, sources: ['CLAUDE.md'] },
        }),
      );
    });

    it('never duplicates a rule: a taken title, its pre-translation original, or a repeat', async () => {
      const { service, db } = setup();
      await service.create(A, { title: 'Use Bun' }, ctx);
      await service.create(B, { title: 'Biome only' }, ctx);
      db.normalizations.push({
        projectId: A,
        fields: [
          {
            field: 'title',
            original: 'Только pnpm',
            sourceHash: textSourceHash('Только pnpm'),
          },
        ],
      });

      const result = await service.addScanned(
        A,
        [
          scanned('use  BUN'),
          scanned('только PNPM'),
          scanned('Biome only'),
          scanned('biome ONLY'),
        ],
        ctx,
      );

      expect(result.created).toBe(1);
      expect(result.skippedTitles).toEqual([
        'use  BUN',
        'только PNPM',
        'biome ONLY',
      ]);
      expect((await service.list(A)).map((r) => r.title)).toEqual([
        'Use Bun',
        'Biome only',
      ]);
    });

    it('writes and audits nothing when every candidate is taken', async () => {
      const { service, db, audit } = setup();
      await service.create(A, { title: 'Use Bun' }, ctx);
      audit.record.mockClear();

      expect(await service.addScanned(A, [scanned('Use Bun')], ctx)).toEqual({
        created: 0,
        skipped: 1,
        rules: [],
        skippedTitles: ['Use Bun'],
      });
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
