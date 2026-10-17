import {
  PROJECT_RULE_ACCEPT_MAX,
  PROJECT_RULE_DESCRIPTION_MAX,
  PROJECT_RULE_IMPORT_MAX,
  PROJECT_RULE_TITLE_MAX,
} from '@agentdock/shared';
import { BadRequestException, type Type, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { AuditContext } from '../audit/audit.types';
import type { AuthUser } from '../auth/auth-request';
import { ROLES_KEY } from '../auth/decorators';
import { PROJECT_ROLE_KEY, ProjectAccessGuard } from '../projects';
import type { ResolvedProjectAccess } from '../projects/project-access.service';
import {
  ProjectRuleAcceptDto,
  ProjectRuleCreateDto,
  ProjectRuleImportDto,
  ProjectRuleReorderDto,
  ProjectRuleUpdateDto,
} from './dto';
import type { ProjectRuleScanService } from './project-rule-scan.service';
import {
  AdminProjectRulesController,
  ProjectRulesController,
} from './project-rules.controller';
import type { ProjectRulesService } from './project-rules.service';

const access: ResolvedProjectAccess = { projectId: 'prj_a', role: 'admin' };
const ctx: AuditContext = { actor: { type: 'user', userId: 'usr_admin' } };

const setup = () => {
  const service = {
    list: jest.fn(async () => []),
    create: jest.fn(async () => ({ id: 'rule_1' })),
    update: jest.fn(async () => ({ id: 'rule_1' })),
    remove: jest.fn(async () => undefined),
    reorder: jest.fn(async () => []),
    import: jest.fn(async () => ({
      created: 0,
      skipped: 0,
      rules: [],
      skippedTitles: [],
    })),
  };
  const scans = {
    scan: jest.fn(async () => ({ candidates: [], scanned: [], warnings: [] })),
    scanPath: jest.fn(async () => ({
      candidates: [],
      scanned: [],
      warnings: [],
    })),
    accept: jest.fn(async () => ({
      created: 0,
      skipped: 0,
      rules: [],
      skippedTitles: [],
    })),
  };
  const controller = new ProjectRulesController(
    service as unknown as ProjectRulesService,
    scans as unknown as ProjectRuleScanService,
  );
  const admin = new AdminProjectRulesController(
    scans as unknown as ProjectRuleScanService,
  );
  return { controller, admin, service, scans };
};

const candidate = { title: 'Use Bun', description: '', source: 'CLAUDE.md' };

/** The app's global pipe (`configure-app.ts`). */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const validate = <T>(dto: Type<T>, value: unknown): Promise<T> =>
  pipe.transform(value, { type: 'body', metatype: dto });

const rejects = async (dto: Type<unknown>, value: unknown) => {
  await expect(validate(dto, value)).rejects.toBeInstanceOf(
    BadRequestException,
  );
};

describe('ProjectRulesController (#528)', () => {
  describe('access', () => {
    const reflector = new Reflector();
    const handler = (name: keyof ProjectRulesController) =>
      ProjectRulesController.prototype[name];

    it('guards every route with ProjectAccessGuard', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, ProjectRulesController),
      ).toEqual([ProjectAccessGuard]);
    });

    it('lets any member read', () => {
      expect(reflector.get(PROJECT_ROLE_KEY, handler('list'))).toBeUndefined();
    });

    it.each([
      'create',
      'import',
      'reorder',
      'update',
      'remove',
      'scan',
      'accept',
    ] as const)('needs the project admin role to %s', (name) => {
      expect(reflector.get(PROJECT_ROLE_KEY, handler(name))).toBe('admin');
    });
  });

  it('keeps the pre-connect scan to admins (#584)', () => {
    expect(new Reflector().get(ROLES_KEY, AdminProjectRulesController)).toEqual(
      ['admin'],
    );
  });

  describe('routes', () => {
    it('scans, accepts and scans a path before connect (#584)', async () => {
      const { controller, admin, scans } = setup();
      const user = { id: 'usr_admin' } as AuthUser;

      await controller.scan(access, ctx);
      await controller.accept(access, user, ctx, { candidates: [candidate] });
      await admin.candidates({ runnerId: 'run_1', path: '/srv/x' }, ctx);

      expect(scans.scan).toHaveBeenCalledWith('prj_a', ctx);
      expect(scans.accept).toHaveBeenCalledWith(
        'prj_a',
        [candidate],
        'usr_admin',
        ctx,
      );
      expect(scans.scanPath).toHaveBeenCalledWith('run_1', '/srv/x', ctx);
    });

    it('lists the rules of the resolved project', async () => {
      const { controller, service } = setup();
      await controller.list(access);
      expect(service.list).toHaveBeenCalledWith('prj_a');
    });

    it('passes the project, the body and the audit context through', async () => {
      const { controller, service } = setup();
      const create = { title: 'Use Bun' } as ProjectRuleCreateDto;
      const update = { enabled: false } as ProjectRuleUpdateDto;

      await controller.create(access, ctx, create);
      await controller.update(access, 'rule_1', ctx, update);
      await controller.remove(access, 'rule_1', ctx);
      await controller.reorder(access, ctx, { ruleIds: ['rule_2', 'rule_1'] });
      await controller.import(access, ctx, { markdown: '## A' });

      expect(service.create).toHaveBeenCalledWith('prj_a', create, ctx);
      expect(service.update).toHaveBeenCalledWith(
        'prj_a',
        'rule_1',
        update,
        ctx,
      );
      expect(service.remove).toHaveBeenCalledWith('prj_a', 'rule_1', ctx);
      expect(service.reorder).toHaveBeenCalledWith(
        'prj_a',
        ['rule_2', 'rule_1'],
        ctx,
      );
      expect(service.import).toHaveBeenCalledWith('prj_a', '## A', ctx);
    });
  });

  describe('input', () => {
    it('accepts a rule and trims its text', async () => {
      expect(
        await validate(ProjectRuleCreateDto, {
          title: '  Use Bun ',
          description: ' Never npm. ',
          enabled: false,
        }),
      ).toEqual({
        title: 'Use Bun',
        description: 'Never npm.',
        enabled: false,
      });
      expect(await validate(ProjectRuleCreateDto, { title: 'T' })).toEqual({
        title: 'T',
      });
    });

    it('rejects an empty, blank, missing or too long title', async () => {
      for (const title of [
        '',
        '   ',
        undefined,
        7,
        'x'.repeat(PROJECT_RULE_TITLE_MAX + 1),
      ]) {
        await rejects(ProjectRuleCreateDto, { title });
        if (title !== undefined) await rejects(ProjectRuleUpdateDto, { title });
      }
    });

    it('rejects a too long description and a non-boolean enabled', async () => {
      const long = 'x'.repeat(PROJECT_RULE_DESCRIPTION_MAX + 1);
      await rejects(ProjectRuleCreateDto, { title: 'T', description: long });
      await rejects(ProjectRuleUpdateDto, { description: long });
      await rejects(ProjectRuleUpdateDto, { enabled: 'yes' });
    });

    it('rejects unknown fields', async () => {
      await rejects(ProjectRuleCreateDto, { title: 'T', position: 3 });
      await rejects(ProjectRuleUpdateDto, { projectId: 'prj_b' });
      await rejects(ProjectRuleReorderDto, { ruleIds: [], extra: true });
      await rejects(ProjectRuleImportDto, { markdown: '', source: 'scanned' });
    });

    it('accepts a partial update', async () => {
      expect(await validate(ProjectRuleUpdateDto, { enabled: true })).toEqual({
        enabled: true,
      });
    });

    it('takes a reorder as a list of distinct ids', async () => {
      expect(
        await validate(ProjectRuleReorderDto, { ruleIds: ['a', 'b'] }),
      ).toEqual({ ruleIds: ['a', 'b'] });
      await rejects(ProjectRuleReorderDto, {});
      await rejects(ProjectRuleReorderDto, { ruleIds: 'a' });
      await rejects(ProjectRuleReorderDto, { ruleIds: ['a', 'a'] });
      await rejects(ProjectRuleReorderDto, { ruleIds: ['a', ''] });
      await rejects(ProjectRuleReorderDto, { ruleIds: [1] });
    });

    it('takes accepted candidates, trimmed, one to the accept limit (#584)', async () => {
      expect(
        await validate(ProjectRuleAcceptDto, {
          candidates: [{ ...candidate, title: ' Use Bun ' }],
        }),
      ).toEqual({ candidates: [candidate] });
      await rejects(ProjectRuleAcceptDto, { candidates: [] });
      await rejects(ProjectRuleAcceptDto, {
        candidates: Array(PROJECT_RULE_ACCEPT_MAX + 1).fill(candidate),
      });
      await rejects(ProjectRuleAcceptDto, {
        candidates: [{ ...candidate, title: '' }],
      });
      await rejects(ProjectRuleAcceptDto, {
        candidates: [{ ...candidate, enabled: false }],
      });
      await rejects(ProjectRuleAcceptDto, {
        candidates: [{ title: 'T', description: '' }],
      });
    });

    it('takes Markdown up to the import limit', async () => {
      expect(await validate(ProjectRuleImportDto, { markdown: '' })).toEqual({
        markdown: '',
      });
      await rejects(ProjectRuleImportDto, {});
      await rejects(ProjectRuleImportDto, {
        markdown: 'x'.repeat(PROJECT_RULE_IMPORT_MAX + 1),
      });
    });
  });
});
