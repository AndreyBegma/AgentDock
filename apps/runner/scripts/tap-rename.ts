// Renames the runner's formula in a checkout of AndreyBegma/homebrew-tap
// (ADR-0073): removes Formula/agentdock-runner.rb and records
// agentdock-runner -> nautelle-runner in formula_renames.json, keeping any
// other rename the tap lists. Homebrew then moves an agentdock-runner install
// to nautelle-runner on `brew upgrade`.
//
//   bun scripts/tap-rename.ts <tap dir>
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FORMULA_RENAMES = { 'agentdock-runner': 'nautelle-runner' };

/** formula_renames.json with the runner's rename merged in. */
export const mergeRenames = (current: string | null): string => {
  const renames = current
    ? (JSON.parse(current) as Record<string, string>)
    : {};
  return `${JSON.stringify({ ...renames, ...FORMULA_RENAMES }, null, 2)}\n`;
};

export const renameInTap = (tap: string): void => {
  const file = join(tap, 'formula_renames.json');
  writeFileSync(
    file,
    mergeRenames(existsSync(file) ? readFileSync(file, 'utf8') : null),
  );
  for (const old of Object.keys(FORMULA_RENAMES)) {
    rmSync(join(tap, 'Formula', `${old}.rb`), { force: true });
  }
};

if (import.meta.main) {
  const tap = process.argv[2];
  if (!tap) {
    console.error('usage: bun scripts/tap-rename.ts <tap dir>');
    process.exit(2);
  }
  renameInTap(tap);
}
