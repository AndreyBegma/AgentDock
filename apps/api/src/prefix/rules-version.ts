import { createHash } from 'node:crypto';
import { type RulesVersionInput, rulesVersionText } from '@nautelle/shared';
import type { PrismaService } from '../database/prisma.service';

/** B6: the SHA-256 of the enabled rules' ordered `(id, title, description, appliesTo)`. */
export const rulesVersionOf = (rules: readonly RulesVersionInput[]): string =>
  createHash('sha256').update(rulesVersionText(rules)).digest('hex');

export const sha256Of = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

export const utf8Bytes = (text: string): number => Buffer.byteLength(text);

/** A project's enabled rules in prompt order, and their version. */
export const enabledRules = async (
  prisma: Pick<PrismaService, 'projectRule'>,
  projectId: string,
) => {
  const rules = await prisma.projectRule.findMany({
    where: { projectId, enabled: true },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      title: true,
      description: true,
      enabled: true,
      appliesTo: true,
    },
  });
  return { rules, version: rulesVersionOf(rules) };
};
