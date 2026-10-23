import type { PrismaService } from '../database/prisma.service';
import type {
  CardFacts,
  CardReviewRunFact,
  CardReviewStepFact,
  CardWithRounds,
} from './board-mapper';

/**
 * #884: the review strip's facts of `cards` — the enabled steps of each
 * project with review on, and each card's runs on its current pull request.
 * Apart from `BoardReview`, which `BoardService` must not import: the rounds
 * service it depends on imports `BoardService`.
 */
export const reviewFactsFor = async (
  prisma: PrismaService,
  cards: readonly Pick<CardWithRounds, 'id' | 'projectId' | 'prNumber'>[],
): Promise<Pick<CardFacts, 'reviewSteps' | 'reviewRuns'>> => {
  const projectIds = [...new Set(cards.map((c) => c.projectId))];
  if (projectIds.length === 0) return {};
  const steps = await prisma.projectReviewStep.findMany({
    where: {
      projectId: { in: projectIds },
      enabled: true,
      project: { boardSettings: { reviewEnabled: true } },
    },
    orderBy: { position: 'asc' },
    select: { id: true, name: true, projectId: true },
  });
  const reviewSteps = new Map<string, CardReviewStepFact[]>();
  for (const { projectId, ...step } of steps) {
    reviewSteps.set(projectId, [...(reviewSteps.get(projectId) ?? []), step]);
  }
  const onPr = cards.flatMap((c) =>
    c.prNumber !== null && reviewSteps.has(c.projectId)
      ? [{ cardId: c.id, prNumber: c.prNumber }]
      : [],
  );
  const reviewRuns = new Map<string, CardReviewRunFact[]>();
  if (onPr.length > 0) {
    const runs = await prisma.boardCardReviewRun.findMany({
      where: { OR: onPr },
      select: {
        cardId: true,
        stepId: true,
        prNumber: true,
        headSha: true,
        pass: true,
        state: true,
        blockingCount: true,
        nitCount: true,
        startedAt: true,
      },
    });
    for (const { cardId, ...run } of runs) {
      reviewRuns.set(cardId, [...(reviewRuns.get(cardId) ?? []), run]);
    }
  }
  return { reviewSteps, reviewRuns };
};
