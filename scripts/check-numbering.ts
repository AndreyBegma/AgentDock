/**
 * Checks that migration and ADR numbers are unique. Parallel cards pick the
 * next number from the same base, so two pull requests can both take it; a
 * pull-request pipeline builds the merge ref, so the second one fails here
 * before it can merge.
 *
 *   bun scripts/check-numbering.ts
 *
 * Fails when two `apps/api/prisma/migrations/` directories share a timestamp
 * prefix, when two `docs/adr/` files share a four-digit number, or when the
 * `docs/adr/README.md` index has a row without a file or a file without a row.
 * Exits 1 and lists the violations when there are any.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

export const MIGRATIONS_DIR = 'apps/api/prisma/migrations';
export const ADR_DIR = 'docs/adr';

/**
 * Applied migrations that already share a prefix. An applied migration is never
 * renamed, so these stay; a group is accepted only while every member is listed
 * here, and a new migration joining one of these prefixes still fails.
 */
export const KNOWN_DUPLICATE_MIGRATIONS: ReadonlySet<string> = new Set([
  '20261206000000_card_ci_retrigger',
  '20261206000000_card_round_finish_refused',
  '20261210000000_login_throttle',
  '20261210000000_spec_folder_in_docs_repo',
  '20261219000000_schedule_firing_principal',
  '20261219000000_scrub_profile_env_values',
  '20261229000000_card_round_blocking_dialog',
  '20261229000000_design_skills_edited',
  '20261229000000_telegram_link_assistant_conversation',
  '20261231000015_github_delivery_body_hash',
  '20261231000015_project_default_branch',
  '20261231000015_telegram_link_confirmation',
  '20261231000016_card_auto_run_armed_by',
  '20261231000016_handoff_note_scope',
  '20261231000022_card_review_runs',
  '20261231000022_design_devices',
]);

const FIX = 'take the next free number from `origin/develop`';

export interface NumberingInput {
  /** Directory names in the migrations folder. */
  migrations: string[];
  /** File names in the ADR folder. */
  adrFiles: string[];
  /** Contents of the ADR index. */
  adrReadme: string;
  knownDuplicateMigrations?: ReadonlySet<string>;
}

const groupBy = (
  names: string[],
  key: (name: string) => string | undefined,
): Map<string, string[]> => {
  const groups = new Map<string, string[]>();
  for (const name of [...names].sort()) {
    const k = key(name);
    if (k === undefined) continue;
    groups.set(k, [...(groups.get(k) ?? []), name]);
  }
  return groups;
};

const migrationPrefix = (name: string) => /^(\d+)_/.exec(name)?.[1];
const adrNumber = (name: string) => /^(\d{4})-.*\.md$/.exec(name)?.[1];

export const checkNumbering = ({
  migrations,
  adrFiles,
  adrReadme,
  knownDuplicateMigrations = KNOWN_DUPLICATE_MIGRATIONS,
}: NumberingInput): string[] => {
  const violations: string[] = [];

  for (const [prefix, dirs] of groupBy(migrations, migrationPrefix)) {
    if (dirs.length < 2 || dirs.every((d) => knownDuplicateMigrations.has(d)))
      continue;
    const paths = dirs.map((d) => `${MIGRATIONS_DIR}/${d}`).join(', ');
    violations.push(
      `migration prefix ${prefix} is used by ${paths}; rename the new one: ${FIX}`,
    );
  }

  const files = groupBy(adrFiles, adrNumber);
  for (const [number, names] of files) {
    if (names.length < 2) continue;
    const paths = names.map((n) => `${ADR_DIR}/${n}`).join(', ');
    violations.push(
      `ADR number ${number} is used by ${paths}; rename the new one: ${FIX}`,
    );
  }

  const rows = new Set(
    [...adrReadme.matchAll(/^\|\s*\[(\d{4})\]/gm)].map((match) => match[1]),
  );
  for (const number of [...rows].sort()) {
    if (!files.has(number))
      violations.push(
        `${ADR_DIR}/README.md has a row for ADR ${number} but no ${ADR_DIR}/${number}-*.md file exists`,
      );
  }
  for (const [number, names] of files) {
    if (!rows.has(number))
      violations.push(
        `${ADR_DIR}/${names[0]} has no row in ${ADR_DIR}/README.md; add one`,
      );
  }

  return violations;
};

if (import.meta.main) {
  const migrations = readdirSync(join(root, MIGRATIONS_DIR), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const adrFiles = readdirSync(join(root, ADR_DIR));
  const adrReadme = readFileSync(join(root, ADR_DIR, 'README.md'), 'utf8');
  const violations = checkNumbering({ migrations, adrFiles, adrReadme });
  if (violations.length > 0) {
    console.error(`check-numbering: ${violations.length} violation(s)`);
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log(
    `check-numbering: ${migrations.length} migration(s), ${adrFiles.length - 1} ADR(s) ok`,
  );
}
