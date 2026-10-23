import { REVIEW_ERROR, REVIEW_INSTRUCTIONS_MAX } from '@nautelle/shared';
import type { Role } from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { LlmGateway } from '../llm/llm-gateway.service';
import { LlmStore } from '../llm/llm-store';
import { projectNotFound } from '../projects';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { reviewError } from './review-error';

/**
 * The repository files peer review instructions are built from, read in
 * this order. A file the checkout does not have is skipped.
 */
export const PEER_REVIEW_SOURCE_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/README.md',
  'docs/adr/README.md',
  'README.md',
] as const;

/** Characters of repository text one generation sends to the model. */
export const PEER_REVIEW_SOURCE_CHARS_MAX = 60_000;
/** Lines of one source file read. */
const SOURCE_LINES_MAX = 400;
const MAX_TOKENS = 4_000;

/**
 * The peer review step's instructions until they are generated: what a
 * careful reviewer checks in any repository. Stored when the first
 * generation fails, so the step is usable and Regenerate can try again.
 */
export const DEFAULT_PEER_REVIEW_INSTRUCTIONS = `# Peer review

Review the pull request as a senior engineer of this repository would.

## Check
- The change does what the card asks, and nothing it does not ask for.
- It follows the conventions of the code around it: naming, structure, error handling, comments.
- It respects the decisions recorded in the repository (ADRs, contributing guides, agent instructions).
- New behaviour and bug fixes come with tests; existing tests still make sense.
- No secrets, debug output, dead code or unrelated changes are left in the diff.

## Severity
- **blocking**: a bug, a broken convention or decision, a missing test the repository requires, or a security problem.
- **nit**: style, naming or wording that would be nice to change but does not hold the card back.
`;

const SYSTEM = `You write the instructions an automated code reviewer follows when it reviews pull requests in one repository.

You are given the repository's own guidance files and its coding rules. Write Markdown instructions, in English, addressed to the reviewer, that:
- start with a "# Peer review" heading and one sentence on the reviewer's role;
- list the concrete conventions this repository states (languages, frameworks, formatting, naming, module boundaries, how data is accessed);
- say which architecture decisions (ADRs) or documents a change must respect, and when a change needs a new ADR;
- state the repository's rules about tests (where they live, what a change must come with);
- end with a "## Severity" section defining "blocking" (a defect, a broken rule or decision, a missing required test, a security problem) and "nit" (style or wording that does not hold the change back).

Use only what the files say; never invent a rule. When the files say little, keep the instructions general. Answer with the Markdown only, no preamble.`;

/** Who asked for the generation: their role gates the runner reads. */
export interface PeerReviewActor {
  userId: string | null;
  role: Role;
  ctx: AuditContext;
}

interface SourceFile {
  path: string;
  content: string;
}

/**
 * Generates a project's peer review instructions (#862, ADR-0084): its
 * runner reads the repository's guidance files (`repo.read`, ADR-0001,
 * ADR-0063), its enabled coding rules are added, and one call through the
 * LLM gateway (ADR-0059) with the instance default model writes the
 * Markdown. Any failure is a typed HTTP error; nothing is stored here.
 */
@Injectable()
export class PeerReviewGenerator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
    private readonly gateway: LlmGateway,
    private readonly llm: LlmStore,
  ) {}

  async generate(projectId: string, actor: PeerReviewActor): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, runnerId: true, rootPath: true, displayName: true },
    });
    if (!project) throw projectNotFound();

    const model = await this.llm.defaultModel();
    if (!model) {
      throw reviewError(
        409,
        REVIEW_ERROR.noModel,
        'No default AI model is set (Admin › AI providers)',
      );
    }

    const files = await this.readSources(project, actor);
    const rules = await this.prisma.projectRule.findMany({
      where: { projectId, enabled: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { title: true, description: true },
    });

    const completion = await this.gateway.complete({
      userId: actor.userId,
      feature: 'review_instructions',
      provider: model.provider,
      request: {
        model: model.model,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: peerReviewPrompt(project.displayName, files, rules),
          },
        ],
        maxTokens: MAX_TOKENS,
      },
    });
    const text = completion.text.trim().slice(0, REVIEW_INSTRUCTIONS_MAX);
    if (!text) {
      throw reviewError(
        502,
        REVIEW_ERROR.generationEmpty,
        'The model returned no instructions; try Regenerate again',
      );
    }
    return text;
  }

  /** The guidance files the checkout has, within the character budget. */
  private async readSources(
    project: { id: string; runnerId: string; rootPath: string },
    actor: PeerReviewActor,
  ): Promise<SourceFile[]> {
    if (!this.presence.isConnected(project.runnerId)) {
      throw reviewError(
        409,
        REVIEW_ERROR.runnerOffline,
        "The project's runner is offline; it reads the repository, so it must be online",
      );
    }
    const support = this.presence.commandSupport(project.runnerId, 'repo.read');
    if (support !== 'supported') {
      throw reviewError(
        409,
        REVIEW_ERROR.runnerUnsupported,
        support === 'disabled'
          ? "The project's runner has repo.read turned off in its config"
          : "The project's runner is too old to read the repository (repo.read); update it",
      );
    }

    const files: SourceFile[] = [];
    let budget = PEER_REVIEW_SOURCE_CHARS_MAX;
    for (const path of PEER_REVIEW_SOURCE_FILES) {
      if (budget <= 0) break;
      const result = await this.commands.send(
        project.runnerId,
        'repo.read',
        {
          projectId: project.id,
          root: project.rootPath,
          path,
          startLine: 1,
          endLine: SOURCE_LINES_MAX,
        },
        { role: actor.role, ctx: actor.ctx },
      );
      if (result.status === 'unknown') {
        throw reviewError(
          503,
          REVIEW_ERROR.runnerNoAnswer,
          "The project's runner did not answer; it may have gone offline",
        );
      }
      // A file the checkout lacks, or the runner's policy denies, is skipped.
      if (result.status === 'error') continue;
      const content = result.output.content.slice(0, budget);
      if (!content.trim()) continue;
      files.push({ path: result.output.path, content });
      budget -= content.length;
    }
    return files;
  }
}

/** The user message of a generation: the files, then the coding rules. */
export const peerReviewPrompt = (
  projectName: string,
  files: readonly SourceFile[],
  rules: readonly { title: string; description: string }[],
): string => {
  const parts = [`Repository: ${projectName}`];
  if (files.length === 0) {
    parts.push('The repository has none of the usual guidance files.');
  }
  for (const file of files) {
    parts.push(`## File: ${file.path}\n\n${file.content}`);
  }
  if (rules.length > 0) {
    parts.push(
      `## Coding rules of the project\n\n${rules
        .map((r) =>
          r.description ? `- ${r.title}: ${r.description}` : `- ${r.title}`,
        )
        .join('\n')}`,
    );
  }
  return parts.join('\n\n');
};
