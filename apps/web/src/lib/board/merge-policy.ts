import type { CardMergePolicy } from '@nautelle/shared';

export const MERGE_POLICY_LABEL = 'Merge pull requests of finished cards';

/** #845 D4: the options of the select, in the order the person reads them. */
export const MERGE_POLICY_OPTIONS: ReadonlyArray<{
  value: CardMergePolicy;
  label: string;
}> = [
  { value: 'ask', label: 'Ask at the start of each run' },
  { value: 'agent', label: 'The agent merges' },
  { value: 'person', label: 'A person merges' },
];

export const MERGE_POLICY_HINT =
  'Applies when a Claude Code session works the Board. A pull request touching .woodpecker/** or carrying a Gate: always goes to a person.';

export const mergePolicyLabel = (policy: CardMergePolicy): string =>
  MERGE_POLICY_OPTIONS.find((option) => option.value === policy)?.label ??
  policy;
