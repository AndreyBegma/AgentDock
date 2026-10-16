import type { Filter } from '../types';
import { jsFilters } from './js';
import { langFilters } from './lang';
import { opsFilters } from './ops';

/**
 * Every family, in match order (#445 D5). This file belongs to i445-engine;
 * a family slot edits only its own folder.
 */
export const FAMILIES: Readonly<Record<string, readonly Filter[]>> = {
  js: jsFilters,
  ops: opsFilters,
  lang: langFilters,
};

/** Every filter of every family, in match order. */
export const ALL_FILTERS: readonly Filter[] = Object.values(FAMILIES).flat();
