import {
  type ProjectRuleCandidateInput,
  type ProjectRuleImportResult,
  type ProjectRuleScanResult,
  ruleTitleKey,
} from '@nautelle/shared';
import type { ProjectScanRulesResult } from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { ProjectInspector, projectNotFound } from '../projects';
import { TextNormalizer } from '../text/text-normalizer';
import { ProjectRulesService } from './project-rules.service';

/**
 * Coding-rule candidates from a project's own docs (#584). The runner reads
 * the files (`project.scan_rules`, ADR-0001); nothing here is stored until a
 * person accepts candidates, which then become enabled rules with source
 * `scanned` and have their text normalized to English (ADR-0027).
 */
@Injectable()
export class ProjectRuleScanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inspector: ProjectInspector,
    private readonly rules: ProjectRulesService,
    private readonly text: TextNormalizer,
  ) {}

  /** Before connect: the project does not exist, so nothing is a duplicate. */
  async scanPath(
    runnerId: string,
    path: string,
    ctx: AuditContext,
  ): Promise<ProjectRuleScanResult> {
    const result = await this.inspector.scanRules(runnerId, path, ctx);
    return annotate(result, new Set());
  }

  /** A rescan of a connected project's root, duplicates marked. */
  async scan(
    projectId: string,
    ctx: AuditContext,
  ): Promise<ProjectRuleScanResult> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { runnerId: true, rootPath: true },
    });
    if (!project) throw projectNotFound();
    const result = await this.inspector.scanRules(
      project.runnerId,
      project.rootPath,
      ctx,
    );
    return annotate(result, await this.rules.takenTitleKeys(projectId));
  }

  /**
   * The person's accepted candidates become rules; each new rule's title
   * and description are then sent to normalization, which never fails the
   * save (ADR-0027 D4).
   */
  async accept(
    projectId: string,
    candidates: readonly ProjectRuleCandidateInput[],
    authorId: string | null,
    ctx: AuditContext,
  ): Promise<ProjectRuleImportResult> {
    const result = await this.rules.addScanned(projectId, candidates, ctx);
    for (const rule of result.rules) {
      await this.text.request(
        projectId,
        { ownerType: 'project_rule', ownerId: rule.id },
        [
          { field: 'title', text: rule.title },
          { field: 'description', text: rule.description },
        ],
        { authorId },
      );
    }
    if (result.rules.length === 0) return result;
    // With DeepL on, the translation lands inside the request: answer it.
    const current = new Map(
      (await this.rules.list(projectId)).map((r) => [r.id, r]),
    );
    return {
      ...result,
      rules: result.rules.map((r) => current.get(r.id) ?? r),
    };
  }
}

const annotate = (
  result: ProjectScanRulesResult,
  taken: ReadonlySet<string>,
): ProjectRuleScanResult => ({
  candidates: result.candidates.map((c) => ({
    ...c,
    duplicate: taken.has(ruleTitleKey(c.title)),
  })),
  scanned: result.scanned,
  warnings: result.warnings,
});
