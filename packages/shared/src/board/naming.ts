import type { BoardCardKind } from './types';

/**
 * How a card is named everywhere outside its row: the `C-n` label, its branch
 * (D5), its spec file (D2), and the text of its issue, PR and leftovers
 * commit (D2, D8). The worktree and tmux names are the runner's, from
 * `cardShortIdSchema` / `cardSessionName` in the protocol.
 */

/** D1: the per-project number as people see it. */
export const cardLabel = (number: number): string => `C-${number}`;

/** #390: "C-39 has been waiting on its own background task for 30 min". */
export const cardBackgroundStalledTitle = (
  number: number,
  minutes: number,
): string =>
  `${cardLabel(number)} has been waiting on its own background task for ${
    minutes % 60 === 0 && minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`
  }`;

/** D8: the line every card PR body carries, so a PR is traced back to its card. */
export const CARD_PR_MARKER = 'AgentDock-Card';

const SLUG_MAX = 40;

/**
 * A branch- and file-safe slug of a title: lower-case ASCII letters and
 * digits joined by `-`, at most 40 characters; `card` when nothing is left.
 */
export const cardSlug = (title: string): string => {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'card';
};

export interface CardBranchInput {
  kind: BoardCardKind;
  number: number;
  title: string;
  issueNumber: number | null;
}

/**
 * D5. With an issue: `feat|fix/<issue>-<slug>`, so #201 D14 links the branch
 * to it. Without: `card/c<number>-<slug>` — the `c` keeps `issueFromBranch`
 * (`^[a-z]+/(\d+)-`) from reading the card number as an issue.
 */
export const cardBranch = (card: CardBranchInput): string => {
  const slug = cardSlug(card.title);
  if (card.issueNumber !== null) {
    const prefix = card.kind === 'bug' ? 'fix' : 'feat';
    return `${prefix}/${card.issueNumber}-${slug}`;
  }
  return `card/c${card.number}-${slug}`;
};

export interface CardSpecPathInput {
  number: number;
  title: string;
  issueNumber: number | null;
}

/**
 * D2: `<specDir>/<issue|card-n>-<slug>.md`, repository-relative. `specDir` is
 * the project's `specDir` (`specDirOf`); a trailing `/` is dropped.
 */
export const cardSpecPath = (
  specDir: string,
  card: CardSpecPathInput,
): string => {
  const dir = specDir.replace(/\/+$/, '');
  return `${dir}/${cardSpecStem(card)}.md`;
};

/** `<issue|card-n>-<slug>`: the spec's file name and the design's folder. */
const cardSpecStem = (card: CardSpecPathInput): string => {
  const stem =
    card.issueNumber !== null ? `${card.issueNumber}` : `card-${card.number}`;
  return `${stem}-${cardSlug(card.title)}`;
};

/** #243 D7: where a card's approved mockup goes when the project has no `specDir`. */
export const CARD_DESIGN_FALLBACK_DIR = 'docs/design/cards';

/**
 * #243 D7, #441: one frame of the approved variant in the card's branch,
 * repository-relative. With a `specDir`, beside the card's spec:
 * `<specDir>/<issue|card-n>-<slug>/design/<variant>/<frame>.html`; without
 * one, `docs/design/cards/C-<n>-<slug>/<variant>/<frame>.html`. `frame` is
 * the frame's slug.
 */
export const cardDesignPath = (
  specDir: string | null,
  card: CardSpecPathInput,
  variant: number,
  frame: string,
): string => {
  const dir = specDir?.replace(/\/+$/, '') ?? '';
  if (dir === '') {
    return `${CARD_DESIGN_FALLBACK_DIR}/${cardLabel(card.number)}-${cardSlug(card.title)}/${variant}/${frame}.html`;
  }
  return `${dir}/${cardSpecStem(card)}/design/${variant}/${frame}.html`;
};

/**
 * #480 (ADR-0044): one frame of a stack's approved design in a stack card's
 * branch, as reference, repository-relative:
 * `<specDir>/stacks/S-<n>-<slug>/design/<variant>/<frame>.html`; without a
 * `specDir`, `docs/design/stacks/S-<n>-<slug>/<variant>/<frame>.html`.
 */
export const stackDesignPath = (
  specDir: string | null,
  stack: { number: number; title: string },
  variant: number,
  frame: string,
): string => {
  const dir = specDir?.replace(/\/+$/, '') ?? '';
  const stem = `S-${stack.number}-${cardSlug(stack.title)}`;
  if (dir === '') return `docs/design/stacks/${stem}/${variant}/${frame}.html`;
  return `${dir}/stacks/${stem}/design/${variant}/${frame}.html`;
};

/** The largest issue body `issue.create` takes. */
export const CARD_ISSUE_BODY_MAX = 20_000;

/** D2: the sentence every issue a card creates ends with. */
export const cardIssueFooter = (number: number): string =>
  `Tracked on Nautelle board card ${cardLabel(number)} — worked by a dedicated worker, not queued for the orchestrator.`;

/**
 * D2: the card body, then the footer. A body too long for the issue is cut
 * with `…` so the footer always fits.
 */
export const cardIssueBody = (body: string, number: number): string => {
  const footer = `\n\n---\n${cardIssueFooter(number)}`;
  const room = CARD_ISSUE_BODY_MAX - footer.length;
  const text = body.trim();
  const kept = text.length > room ? `${text.slice(0, room - 1)}…` : text;
  return `${kept}${footer}`;
};

export interface CardSpecPrBodyInput {
  number: number;
  title: string;
  /** `owner/name` of the code repository. */
  repo: string;
  issueNumber: number | null;
}

/**
 * #379: the body of a card's spec pull request in an external docs
 * repository. It names the code issue as `owner/name#n`, so GitHub links
 * the issue back to it.
 */
export const cardSpecPrBody = (pr: CardSpecPrBodyInput): string => {
  const label = cardLabel(pr.number);
  const lines = [
    `Specification of Nautelle board card ${label}: ${pr.title}`,
    '',
    pr.issueNumber !== null
      ? `Code: ${pr.repo}#${pr.issueNumber}`
      : `Code: ${pr.repo}`,
    '',
    `${CARD_PR_MARKER}: ${label}`,
  ];
  return `${lines.join('\n')}\n`;
};

export interface CardPullRequestBodyInput {
  number: number;
  /** The latest round's summary; a default line when there is none. */
  summary: string | null;
  issueNumber: number | null;
  /** #379: the spec's pull request in an external docs repository. */
  specPrUrl?: string | null;
}

/**
 * D8: summary, the spec's docs pull request (#379), `Closes #n` when there
 * is an issue, and the marker line.
 */
export const cardPullRequestBody = (pr: CardPullRequestBodyInput): string => {
  const summary =
    pr.summary?.trim() ||
    `Work of Nautelle board card ${cardLabel(pr.number)}.`;
  const parts = [summary];
  if (pr.specPrUrl) parts.push(`Spec: ${pr.specPrUrl}`);
  if (pr.issueNumber !== null) parts.push(`Closes #${pr.issueNumber}`);
  parts.push(`${CARD_PR_MARKER}: ${cardLabel(pr.number)}`);
  return parts.join('\n\n');
};

/** D8: the commit `card.collect` makes of uncommitted leftovers. */
export const cardWipCommitMessage = (number: number): string =>
  `chore: card ${cardLabel(number)} work in progress`;
