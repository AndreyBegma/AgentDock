import {
  BOARD_ASK_HITS_MAX,
  type BoardAskHit,
  type BoardAskQuery,
  type BoardAskResponse,
  type BoardSearchResponse,
  cardLabel,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { LlmGateway } from '../llm/llm-gateway.service';
import { ProjectAccessService } from '../projects';
import { parseAskAnswer, projectsOfQuery } from './ask-query';
import { boardAiError } from './board-ai-error';
import { BoardAiModel } from './board-ai-model';
import { modelJson } from './model-json';
import { askAnswerPrompt, askQueryPrompt } from './prompts';

/** Output tokens of the query call; a query is a short object. */
const QUERY_MAX_TOKENS = 600;
/** Output tokens of the answer call: three short sentences. */
const ANSWER_MAX_TOKENS = 500;
/** Hits of each source read before they are merged. */
const PER_SOURCE = BOARD_ASK_HITS_MAX;

const DAY_MS = 86_400_000;

interface ScopedProject {
  id: string;
  displayName: string;
  repo: string;
}

/**
 * #660 Ask the Board: a question becomes a structured query (one model call),
 * the query runs over the cards, pull requests and activity of the projects
 * the person can access, and a short reply in the question's language is
 * written over what was found (a second call). Both calls go through the
 * gateway tagged `search`, so the caps apply; the query never reaches a
 * project outside the person's access, whatever the model writes.
 */
@Injectable()
export class BoardAskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: LlmGateway,
    private readonly access: ProjectAccessService,
    private readonly model: BoardAiModel,
  ) {}

  async ask(user: AuthUser, question: string): Promise<BoardAskResponse> {
    const picked = await this.model.pick();
    const accessible = await this.prisma.project.findMany({
      where: this.access.visibleWhere(user),
      select: { id: true, displayName: true, repo: true },
      orderBy: { displayName: 'asc' },
    });

    const queried = await this.gateway.complete({
      userId: user.id,
      feature: 'search',
      provider: picked.provider,
      request: {
        model: picked.model,
        system: askQueryPrompt({ now: new Date(), projects: accessible }),
        messages: [{ role: 'user', content: question }],
        maxTokens: QUERY_MAX_TOKENS,
      },
    });
    const parsed = parseAskAnswer(modelJson(queried.text));
    if (!parsed) {
      // Not 502: the web reads a gateway status as the API being down.
      throw boardAiError(
        422,
        'ai_bad_answer',
        'The model did not turn the question into a query; try asking differently',
      );
    }

    const scope = projectsOfQuery(parsed.query.projects, accessible);
    const { hits, total } = await this.search(scope, parsed.query);

    const answered = await this.gateway.complete({
      userId: user.id,
      feature: 'search',
      provider: picked.provider,
      request: {
        model: picked.model,
        system: askAnswerPrompt({
          language: parsed.language,
          query: parsed.query,
          hits,
          total,
        }),
        messages: [{ role: 'user', content: question }],
        maxTokens: ANSWER_MAX_TOKENS,
      },
    });
    return {
      answer: answered.text.trim(),
      language: parsed.language,
      query: parsed.query,
      hits,
    };
  }

  /** `POST /board/search`: a query again, over the person's projects, no model. */
  async searchAgain(
    user: AuthUser,
    query: BoardAskQuery,
  ): Promise<BoardSearchResponse> {
    const accessible = await this.prisma.project.findMany({
      where: this.access.visibleWhere(user),
      select: { id: true, displayName: true, repo: true },
    });
    const { hits } = await this.search(
      projectsOfQuery(query.projects, accessible),
      query,
    );
    return { hits };
  }

  /** The hits of a query in `scope`, newest first, and how many there were. */
  async search(
    scope: ScopedProject[],
    query: BoardAskQuery,
  ): Promise<{ hits: BoardAskHit[]; total: number }> {
    if (scope.length === 0) return { hits: [], total: 0 };
    const nameOf = new Map(scope.map((p) => [p.id, p.displayName]));
    const projectIds = scope.map((p) => p.id);
    const since = query.withinDays
      ? new Date(Date.now() - query.withinDays * DAY_MS)
      : null;
    const titleHas = query.text.map((word) => ({
      title: { contains: word, mode: 'insensitive' as const },
    }));

    const found: { ts: Date; hit: BoardAskHit }[] = [];
    let total = 0;

    const wantsCards = query.sources.includes('cards');
    const wantsPrs = query.sources.includes('prs');
    if (wantsCards || wantsPrs) {
      const and: Prisma.BoardCardWhereInput[] = [
        { projectId: { in: projectIds } },
        ...titleHas,
      ];
      if (query.columns.length > 0) and.push({ column: { in: query.columns } });
      if (query.kind) and.push({ kind: query.kind });
      if (since) and.push({ createdAt: { gte: since } });
      if (query.prState === 'open') {
        and.push({ prState: { in: ['open', 'draft'] } });
      } else if (query.prState) {
        and.push({ prState: query.prState });
      }
      if (query.checks) {
        and.push({
          ciState: {
            failed: 'red' as const,
            passed: 'green' as const,
            pending: 'pending' as const,
          }[query.checks],
        });
      }
      // A question about pull requests only reads cards that have one.
      if (!wantsCards || query.prState || query.checks) {
        and.push({ prNumber: { not: null } });
      }
      const where = { AND: and };
      const [cards, count] = await Promise.all([
        this.prisma.boardCard.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          take: PER_SOURCE,
          select: {
            projectId: true,
            number: true,
            title: true,
            column: true,
            kind: true,
            prNumber: true,
            prUrl: true,
            prState: true,
            updatedAt: true,
          },
        }),
        this.prisma.boardCard.count({ where }),
      ]);
      total += count;
      for (const card of cards) {
        const projectName = nameOf.get(card.projectId) ?? '';
        if (wantsCards) {
          found.push({
            ts: card.updatedAt,
            hit: {
              type: 'card',
              projectId: card.projectId,
              projectName,
              number: card.number,
              label: cardLabel(card.number),
              title: card.title,
              column: card.column,
              kind: card.kind,
              prNumber: card.prNumber,
              prUrl: card.prUrl,
            },
          });
        } else if (card.prNumber !== null && card.prUrl !== null) {
          found.push({
            ts: card.updatedAt,
            hit: {
              type: 'pr',
              projectId: card.projectId,
              projectName,
              cardNumber: card.number,
              number: card.prNumber,
              title: card.title,
              state: card.prState,
              url: card.prUrl,
            },
          });
        }
      }
    }

    // Activity has no column, kind or PR state: a query that narrows by one
    // of them is about cards, and activity would only add noise.
    const activityFits =
      query.columns.length === 0 &&
      !query.kind &&
      !query.prState &&
      !query.checks;
    if (query.sources.includes('activity') && activityFits) {
      const where: Prisma.ActivityItemWhereInput = {
        AND: [
          { projectId: { in: projectIds } },
          ...titleHas,
          ...(since ? [{ ts: { gte: since } }] : []),
        ],
      };
      const [items, count] = await Promise.all([
        this.prisma.activityItem.findMany({
          where,
          orderBy: [{ ts: 'desc' }, { id: 'desc' }],
          take: PER_SOURCE,
          select: {
            id: true,
            projectId: true,
            title: true,
            ts: true,
            link: true,
          },
        }),
        this.prisma.activityItem.count({ where }),
      ]);
      total += count;
      for (const item of items) {
        if (!item.projectId) continue;
        found.push({
          ts: item.ts,
          hit: {
            type: 'activity',
            projectId: item.projectId,
            projectName: nameOf.get(item.projectId) ?? '',
            id: item.id.toString(),
            title: item.title,
            ts: item.ts.toISOString(),
            link: item.link,
          },
        });
      }
    }

    // Cards and pull requests first: they are what the question links to.
    const rank = (hit: BoardAskHit) => (hit.type === 'activity' ? 1 : 0);
    found.sort(
      (a, b) => rank(a.hit) - rank(b.hit) || b.ts.getTime() - a.ts.getTime(),
    );
    return {
      hits: found.slice(0, BOARD_ASK_HITS_MAX).map((f) => f.hit),
      total,
    };
  }
}
