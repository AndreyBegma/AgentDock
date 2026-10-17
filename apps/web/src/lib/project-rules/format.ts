import {
  PROJECT_RULE_ERROR,
  type ProjectRuleSource,
  type ProjectRuleView,
} from '@agentdock/shared';
import { ApiError } from '../api';
import { describeProjectError } from '../projects/format';

export const SOURCE_LABEL: Record<ProjectRuleSource, string> = {
  manual: 'Manual',
  imported: 'Imported',
  scanned: 'Scanned',
};

export type RuleFilter = 'all' | 'enabled' | 'disabled';

/** The rules a search text and an enabled filter leave, in list order. */
export function filterRules(
  rules: readonly ProjectRuleView[],
  search: string,
  filter: RuleFilter,
): ProjectRuleView[] {
  const needle = search.trim().toLowerCase();
  return rules.filter((rule) => {
    if (filter === 'enabled' && !rule.enabled) return false;
    if (filter === 'disabled' && rule.enabled) return false;
    if (!needle) return true;
    return (
      rule.title.toLowerCase().includes(needle) ||
      rule.description.toLowerCase().includes(needle)
    );
  });
}

/** The list with the rule at `index` swapped with its neighbour; same list at an edge. */
export function moveRule<T>(
  rules: readonly T[],
  index: number,
  direction: -1 | 1,
): T[] {
  const target = index + direction;
  if (index < 0 || index >= rules.length) return [...rules];
  if (target < 0 || target >= rules.length) return [...rules];
  const next = [...rules];
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
}

/**
 * The block the worker's prompt carries: enabled rules only, in list order.
 * Mirrors the injection of C-227; the screen shows it so the two can be compared.
 */
export function workerPromptBlock(rules: readonly ProjectRuleView[]): string {
  const enabled = rules.filter((rule) => rule.enabled);
  if (enabled.length === 0) return '';
  const lines = enabled.map((rule, i) => {
    const text = rule.description.trim();
    return `${i + 1}. **${rule.title}**${text ? ` — ${text}` : ''}`;
  });
  return [
    '## Project coding rules',
    'Follow every rule below in the code you write for this project.',
    ...lines,
  ].join('\n');
}

/** "3 created, 1 skipped" for the import result. */
export function importSummary(created: number, skipped: number): string {
  const noun = (n: number) => (n === 1 ? 'rule' : 'rules');
  return `${created} ${noun(created)} created, ${skipped} skipped as ${
    skipped === 1 ? 'a duplicate' : 'duplicates'
  }.`;
}

export function describeRuleError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code as string | undefined) {
      case PROJECT_RULE_ERROR.notFound:
        return 'That rule no longer exists. The list has been reloaded.';
      case PROJECT_RULE_ERROR.orderMismatch:
        return 'The rules changed while you were reordering. The list has been reloaded; try again.';
    }
    if (error.status === 403) {
      return 'Only a project administrator can change the rules.';
    }
  }
  return describeProjectError(error);
}
