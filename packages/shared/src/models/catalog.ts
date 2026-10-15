/**
 * The Claude model catalog (issue #322 D4, ADR-0032 §5): the aliases a person
 * picks from, in the order a select lists them, with the label each shows.
 *
 * What is sent and stored stays the **alias** — a run, a card, a command. The
 * label is display only and claims what the alias resolves to on a current
 * Claude Code; update it in the change that moves the default generation.
 */
export const CLAUDE_MODELS = [
  { alias: 'opus', label: 'Opus 5.5' },
  { alias: 'sonnet', label: 'Sonnet 5.5' },
  { alias: 'haiku', label: 'Haiku 5.5' },
  { alias: 'fable', label: 'Fable 5.1' },
] as const satisfies readonly { alias: string; label: string }[];

export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export type ClaudeModelAlias = ClaudeModel['alias'];

export const CLAUDE_MODEL_ALIASES: readonly ClaudeModelAlias[] =
  CLAUDE_MODELS.map((m) => m.alias);

export const isClaudeModelAlias = (value: string): value is ClaudeModelAlias =>
  (CLAUDE_MODEL_ALIASES as readonly string[]).includes(value);

/**
 * The label of a stored model value: the catalog's for an alias, else the
 * value itself — a full id (`claude-opus-5-5`) or a variant (`opus[1m]`) is
 * shown as it is stored, never mapped to a near alias (D4).
 */
export const claudeModelLabel = (value: string): string =>
  CLAUDE_MODELS.find((m) => m.alias === value)?.label ?? value;

/** The suffix of the option that equals the recommendation (D2). */
export const RECOMMENDED_SUFFIX = ' (recommended)';

/** One option of a model select. `value` is what is sent. */
export interface ClaudeModelOption {
  value: string;
  /** `Opus 5.5`, or `Opus 5.5 (recommended)`. */
  label: string;
  /** In the catalog; `false` for a stored value the catalog does not know. */
  inCatalog: boolean;
  recommended: boolean;
}

/**
 * The options of a model select (D2, D4): the catalog in order, the one
 * equal to `recommended` suffixed ` (recommended)`. A `selected` value the
 * catalog does not know is listed first as its own option, so opening and
 * saving a form never rewrites it. A blank value counts as none.
 */
export const claudeModelOptions = (opts: {
  selected?: string | null;
  recommended?: string | null;
}): ClaudeModelOption[] => {
  const recommended = opts.recommended?.trim() || null;
  const selected = opts.selected?.trim() || null;
  const option = (value: string, inCatalog: boolean): ClaudeModelOption => {
    const isRecommended = value === recommended;
    return {
      value,
      label: `${claudeModelLabel(value)}${isRecommended ? RECOMMENDED_SUFFIX : ''}`,
      inCatalog,
      recommended: isRecommended,
    };
  };
  const catalog = CLAUDE_MODELS.map((m) => option(m.alias, true));
  return selected !== null && !isClaudeModelAlias(selected)
    ? [option(selected, false), ...catalog]
    : catalog;
};
