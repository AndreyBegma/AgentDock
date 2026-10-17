/** C-227: the rules block of an agent prompt, at most this many UTF-8 bytes. */
export const PROJECT_RULES_BLOCK_MAX_BYTES = 12 * 1024;

/** What the block ends with when rules were left out; never silent. */
export const projectRulesCutMarker = (omitted: number): string =>
  `[${omitted} more rule${omitted === 1 ? '' : 's'} not shown: the project's rules exceed the size limit of this block. Ask the person to shorten them.]`;

/** The part of a rule the prompt needs. */
export interface ProjectRulePromptInput {
  title: string;
  description: string;
  enabled: boolean;
}

export interface ProjectRulesBlock {
  /** The `## Project coding rules` section; `null` without an enabled rule. */
  text: string | null;
  /** Enabled rules that did not fit, counted in the marker. */
  omitted: number;
}

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

const ruleItem = (index: number, rule: ProjectRulePromptInput): string => {
  const title = rule.title.replace(/\s+/g, ' ').trim();
  const description = rule.description.trim();
  return description
    ? `${index}. ${title}\n${description.replace(/^/gm, '   ')}`
    : `${index}. ${title}`;
};

const HEADER = [
  '## Project coding rules',
  '',
  "These are the project's coding rules. Follow them in all code you write; where one conflicts with the card, say so in your summary.",
  '',
];

/**
 * C-227: the project's enabled rules, in the order given, as one delimited
 * section. Rules are kept whole while they fit `maxBytes`; the rest are
 * dropped and counted in a marker line.
 */
export const projectRulesBlock = (
  rules: readonly ProjectRulePromptInput[],
  maxBytes = PROJECT_RULES_BLOCK_MAX_BYTES,
): ProjectRulesBlock => {
  const enabled = rules.filter((r) => r.enabled);
  if (enabled.length === 0) return { text: null, omitted: 0 };
  const head = HEADER.join('\n');
  const kept: string[] = [];
  let used = utf8Bytes(head);
  for (const [i, rule] of enabled.entries()) {
    const item = ruleItem(i + 1, rule);
    const left = enabled.length - i - 1;
    // Reserve room for the marker unless this is the last rule.
    const reserve = left > 0 ? utf8Bytes(projectRulesCutMarker(left)) + 2 : 0;
    if (used + utf8Bytes(item) + 2 + reserve > maxBytes) break;
    kept.push(item);
    used += utf8Bytes(item) + 2;
  }
  const omitted = enabled.length - kept.length;
  const body = [...kept];
  if (omitted > 0) body.push(projectRulesCutMarker(omitted));
  return { text: `${head}\n${body.join('\n\n')}`, omitted };
};
