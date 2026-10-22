import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  convertLangfusePrices,
  type LangfuseConversion,
  type LangfuseModel,
} from './langfuse';

/**
 * The API package root: the nearest directory with a package.json. This file
 * runs from `src/prices` in the repository and from `dist/src/prices` in the
 * image (the compiled seed), so a fixed `../..` would miss in one of them.
 */
export const findApiRoot = (dir: string): string =>
  existsSync(resolve(dir, 'package.json')) || dirname(dir) === dir
    ? dir
    : findApiRoot(dirname(dir));

/** The vendored Langfuse snapshot (spec 13 D4; see its ATTRIBUTION.md). */
export const LANGFUSE_SNAPSHOT_PATH = resolve(
  findApiRoot(__dirname),
  'prisma/seed-data/langfuse-model-prices.json',
);

export const readLangfuseSnapshot = (): LangfuseModel[] =>
  JSON.parse(readFileSync(LANGFUSE_SNAPSHOT_PATH, 'utf8')) as LangfuseModel[];

export interface SeedPricesResult {
  created: boolean;
  conversion: LangfuseConversion | null;
}

/**
 * Creates price version 1 (`langfuse-seed`) from the snapshot — only when no
 * version exists, so re-running the seed never touches prices an admin edited.
 */
export const seedPrices = async (
  prisma: PrismaClient,
): Promise<SeedPricesResult> => {
  if ((await prisma.priceVersion.count()) > 0) {
    return { created: false, conversion: null };
  }
  const conversion = convertLangfusePrices(readLangfuseSnapshot());
  await prisma.priceVersion.create({
    data: {
      number: 1,
      source: 'langfuse_seed',
      note: 'Langfuse default-model-prices.json @ 734cc86',
      models: {
        create: conversion.prices.map((p) => ({
          modelName: p.modelName,
          matchPattern: p.matchPattern,
          priority: p.priority,
          tiers: p.tiers as unknown as Prisma.InputJsonValue,
        })),
      },
    },
  });
  return { created: true, conversion };
};

/** The converter's report, one line per finding, for the seed's output. */
export const describeConversion = (c: LangfuseConversion): string[] => [
  `${c.prices.length} model prices`,
  ...[...c.unknownKeys.keys()]
    .sort()
    .map((k) => `unknown usage key dropped: ${k}`),
  ...c.droppedModels.map((m) => `model dropped: ${m}`),
  ...c.conflicts.map((m) => `conflict: ${m}`),
  `${c.droppedTiers.length} tiers dropped (conditions on request parameters or no input/output price)`,
];
