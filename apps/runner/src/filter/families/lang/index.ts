import type { Filter } from '../../types';
import { dotnetFilter } from './dotnet';
import { findFilter, lsFilter, searchFilter, treeFilter } from './files';
import { goTestFilter } from './go';
import { gradleFilter, mavenFilter } from './jvm';
import { composerFilter, phpunitFilter } from './php';
import { pipFilter, poetryFilter, pytestFilter, ruffFilter } from './python';
import { bundleFilter, rspecFilter, rubocopFilter } from './ruby';
import { cargoFilter } from './rust';

/**
 * Other languages and file tools: pytest, ruff, pip, poetry, go test, cargo,
 * rspec, rubocop, bundler, maven, gradle, dotnet, phpunit, composer, and the
 * long listings of find / ls / tree / grep / rg. Each filter shortens the
 * progress and listing noise of its command and keeps every error, warning
 * and failure line. Cases live in `./corpus`.
 */
export const langFilters: readonly Filter[] = [
  pytestFilter,
  ruffFilter,
  pipFilter,
  poetryFilter,
  goTestFilter,
  cargoFilter,
  rspecFilter,
  rubocopFilter,
  bundleFilter,
  mavenFilter,
  gradleFilter,
  dotnetFilter,
  phpunitFilter,
  composerFilter,
  findFilter,
  lsFilter,
  treeFilter,
  searchFilter,
];
