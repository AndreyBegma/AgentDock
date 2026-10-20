import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/**
 * The planner's default instructions (spec 172 D11, ADR-0019), authored in
 * `packages/shared/src/planner/default-instructions.md`. Resolved through the
 * package, so it reads the same file from the repository and from the API
 * image (which carries `packages/shared` whole).
 */
export const DEFAULT_PLANNER_INSTRUCTIONS_PATH = resolve(
  dirname(require.resolve('@nautelle/shared')),
  '../src/planner/default-instructions.md',
);

export const readDefaultPlannerInstructions = (): string =>
  readFileSync(DEFAULT_PLANNER_INSTRUCTIONS_PATH, 'utf8');

/**
 * Creates global instructions version 1 — only when no global version exists,
 * so re-running the seed never touches instructions an admin edited.
 */
export const seedPlannerInstructions = async (
  prisma: PrismaClient,
): Promise<{ created: boolean }> => {
  if (
    (await prisma.plannerInstructions.count({ where: { projectId: null } })) > 0
  ) {
    return { created: false };
  }
  await prisma.plannerInstructions.create({
    data: {
      projectId: null,
      version: 1,
      body: readDefaultPlannerInstructions(),
      authorId: null,
    },
  });
  return { created: true };
};
