import {
  AI_SUMMARY_MAX,
  type AiSummaryErrorCode,
  type AiSummarySubject,
  type AiSummaryView,
} from '@nautelle/shared';
import { HttpException, Injectable } from '@nestjs/common';
import type { AiSummary } from '@prisma/client';
import { cardNotFound } from '../board/board-error';
import { PrismaService } from '../database/prisma.service';
import { LlmGateway } from '../llm/llm-gateway.service';
import { LlmStore } from '../llm/llm-store';
import { sessionNotFound } from '../sessions/session-error';
import {
  CARD_ROUNDS_READ,
  cardSource,
  type SessionSourceRow,
  sessionSource,
  sourceHash,
} from './summary-sources';

/** A summary is a short read. */
const SUMMARY_MAX_TOKENS = 1_200;

const SUBJECT_TEXT: Record<AiSummarySubject, string> = {
  card: 'a Board card of a software project and its pull request. Say what changed, how CI stands, the review state and what remains to be done',
  session:
    'an AI coding agent session, from its stored transcript. Say what the person asked for, what the agent did, how it ended or stands, and what remains',
};

/** The system prompt: what to summarize, in the reader's language. */
export const summarySystem = (
  subject: AiSummarySubject,
  language: string,
): string =>
  [
    `You summarize ${SUBJECT_TEXT[subject]}.`,
    `Write in the language whose BCP 47 code is "${language}", whatever language the source is in.`,
    'Write at most five short sentences of plain text: no greeting, no headings, no Markdown.',
    'Use only what the source says; when something is unknown, do not guess.',
  ].join('\n');

export const summaryError = (
  statusCode: number,
  error: AiSummaryErrorCode,
  message: string,
): HttpException =>
  new HttpException({ statusCode, error, message }, statusCode);

const viewOf = (row: AiSummary, cached: boolean): AiSummaryView => ({
  subject: row.subject,
  subjectId: row.subjectId,
  language: row.language,
  text: row.text,
  provider: row.provider,
  model: row.model,
  costUsd: row.costUsd.toString(),
  cached,
  createdAt: row.updatedAt.toISOString(),
});

interface Source {
  projectId: string;
  subject: AiSummarySubject;
  subjectId: string;
  text: string;
}

/**
 * One-click summaries of a card with its PR, and of a session (#658), made by
 * the instance's default model through the gateway — tagged `summary`, under
 * the provider's cap, which answers `llm_cap_reached` (429) like every other
 * gateway call. A summary is cached per subject and reader language with the
 * hash of its source: asked again with nothing changed, it is served from
 * `ai_summaries` with no call and no `llm_calls` row.
 */
@Injectable()
export class SummariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: LlmGateway,
    private readonly llm: LlmStore,
  ) {}

  async card(
    projectId: string,
    number: number,
    reader: { userId: string; language: string; regenerate: boolean },
  ): Promise<AiSummaryView> {
    const card = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
      select: {
        id: true,
        number: true,
        title: true,
        body: true,
        kind: true,
        column: true,
        branch: true,
        prNumber: true,
        prUrl: true,
        prState: true,
        prBase: true,
        ciState: true,
        ciChecks: true,
        ciFixAttempts: true,
        needsPerson: true,
        needsPersonReason: true,
        mergedAt: true,
        rounds: {
          orderBy: { round: 'desc' },
          take: CARD_ROUNDS_READ,
          select: {
            round: true,
            trigger: true,
            phase: true,
            feedback: true,
            summary: true,
            error: true,
          },
        },
      },
    });
    if (!card) throw cardNotFound();
    return this.summarize(
      {
        projectId,
        subject: 'card',
        subjectId: card.id,
        text: cardSource(card),
      },
      reader,
    );
  }

  /**
   * Only for a project that ships session content and a session that has
   * some (ADR-0021); otherwise `summary_no_session_content`.
   */
  async session(
    projectId: string,
    sessionId: string,
    reader: { userId: string; language: string; regenerate: boolean },
  ): Promise<AiSummaryView> {
    const session = await this.prisma.agentSession.findFirst({
      where: { id: sessionId, projectId },
      select: {
        id: true,
        title: true,
        gitBranch: true,
        startedAt: true,
        endedAt: true,
        project: { select: { shipSessionContent: true } },
      },
    });
    if (!session) throw sessionNotFound();
    const content: SessionSourceRow['content'] = session.project
      ?.shipSessionContent
      ? await this.prisma.sessionContent.findMany({
          where: { sessionId, projectId },
          orderBy: [{ at: 'asc' }, { id: 'asc' }],
          select: { kind: true, toolName: true, text: true },
        })
      : [];
    if (content.length === 0) {
      throw summaryError(
        409,
        'summary_no_session_content',
        'This project does not store session content, or this session has none',
      );
    }
    return this.summarize(
      {
        projectId,
        subject: 'session',
        subjectId: session.id,
        text: sessionSource({ ...session, content }),
      },
      reader,
    );
  }

  private async summarize(
    source: Source,
    reader: { userId: string; language: string; regenerate: boolean },
  ): Promise<AiSummaryView> {
    const hash = sourceHash(source.text);
    const key = {
      subject: source.subject,
      subjectId: source.subjectId,
      language: reader.language,
    };
    const cached = await this.prisma.aiSummary.findUnique({
      where: { subject_subjectId_language: key },
    });
    if (cached && cached.sourceHash === hash && !reader.regenerate) {
      return viewOf(cached, true);
    }

    const model = await this.llm.defaultModel();
    if (!model) {
      throw summaryError(
        409,
        'summary_no_model',
        'No default AI model is set (Admin › AI providers)',
      );
    }
    const completion = await this.gateway.complete({
      userId: reader.userId,
      feature: 'summary',
      provider: model.provider,
      request: {
        model: model.model,
        system: summarySystem(source.subject, reader.language),
        messages: [{ role: 'user', content: source.text }],
        maxTokens: SUMMARY_MAX_TOKENS,
      },
    });
    const text = completion.text.trim().slice(0, AI_SUMMARY_MAX);
    const data = {
      projectId: source.projectId,
      sourceHash: hash,
      text,
      provider: model.provider,
      model: model.model,
      costUsd: completion.costUsd,
    };
    const row = await this.prisma.aiSummary.upsert({
      where: { subject_subjectId_language: key },
      create: { ...key, ...data },
      update: data,
    });
    return viewOf(row, false);
  }
}
