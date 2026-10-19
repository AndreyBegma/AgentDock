import {
  BOARD_ASK_CHECKS,
  BOARD_ASK_PR_STATES,
  BOARD_ASK_SOURCES,
  BOARD_CARD_KINDS,
  BOARD_COLUMNS,
  type BoardAskHit,
  type BoardAskQuery,
} from '@agentdock/shared';

const list = (values: readonly string[]) =>
  values.map((v) => `"${v}"`).join(', ');

/**
 * #660: turns a question into a query. The project names are the person's
 * own, so the model can name only projects they can access.
 */
export const askQueryPrompt = (input: {
  now: Date;
  projects: { displayName: string; repo: string }[];
}): string =>
  [
    'You turn a question about an AgentDock Board into a search query. AgentDock is a control plane for agent fleets: each project has a Board of cards (columns inbox, todo, in_progress, finished, completed), cards open pull requests, and an activity feed records what happened.',
    'Answer with one JSON object and nothing else:',
    `{"language": "<BCP 47 primary code of the question, e.g. en, ru>", "projects": [<project names the question names, from the list below; [] for all>], "text": [<at most 8 keywords a matching title must contain, in English>], "columns": [<any of ${list(BOARD_COLUMNS)}>], "kind": <${list(BOARD_CARD_KINDS)} or null>, "prState": <${list(BOARD_ASK_PR_STATES)} or null>, "checks": <${list(BOARD_ASK_CHECKS)} or null>, "withinDays": <number or null>, "sources": [<any of ${list(BOARD_ASK_SOURCES)}; [] for all>]}`,
    'Stored text is English: translate keywords to English. Leave out words that only say what to search ("cards", "show", "which"). Use a field only when the question asks for it; null and [] narrow nothing.',
    '"Review", "waiting for review" and "done" are the finished column; "in progress" is in_progress; "queued" or "to do" is todo; "accepted" is completed. "Failed checks", "red CI" is checks failed.',
    '',
    `Today is ${input.now.toISOString().slice(0, 10)}.`,
    'Projects:',
    ...input.projects.map((p) => `- ${p.displayName} (${p.repo})`),
  ].join('\n');

/** How a hit is written for the answer model: one line, with its reference. */
export const hitLine = (hit: BoardAskHit): string => {
  switch (hit.type) {
    case 'card':
      return `[${hit.label}] ${hit.title} — ${hit.projectName}, ${hit.column}, ${hit.kind}${hit.prNumber ? `, PR #${hit.prNumber}` : ''}`;
    case 'pr':
      return `[PR #${hit.number}] ${hit.title} — ${hit.projectName}, ${hit.state ?? 'unknown state'}`;
    case 'activity':
      return `[activity] ${hit.ts.slice(0, 16).replace('T', ' ')} ${hit.title} — ${hit.projectName}`;
  }
};

/** #660: the short reply, in the question's language, over what was found. */
export const askAnswerPrompt = (input: {
  language: string;
  query: BoardAskQuery;
  hits: BoardAskHit[];
  total: number;
}): string =>
  [
    'You answer a question about an AgentDock Board from search results. Use only the results; never invent cards, pull requests or numbers.',
    `Write in the language of the question (code ${input.language}; if that is "und", the question's own language). At most three short sentences, plain text, no Markdown headings or lists.`,
    'Name the cards and pull requests you mention exactly as written in brackets, e.g. [C-12] or [PR #34]; the reader sees them as links.',
    'When there are no results, say nothing matched and suggest one way to ask differently.',
    '',
    `Results (${input.total} found, ${input.hits.length} shown):`,
    ...(input.hits.length > 0 ? input.hits.map(hitLine) : ['(none)']),
  ].join('\n');

export interface TriageCandidate {
  number: number;
  title: string;
  body: string;
  column: string;
}

/** Characters of a card body the triage model sees. */
const BODY_EXCERPT = 600;

const excerpt = (body: string) =>
  body.length > BODY_EXCERPT ? `${body.slice(0, BODY_EXCERPT)}…` : body;

/**
 * #660: duplicates, kind and priority of a new card, as advice. The model
 * recommendation is ADR-0032's assessment and is never asked for here.
 */
export const triagePrompt = (input: {
  card: { title: string; body: string; kind: string };
  open: TriageCandidate[];
}): string =>
  [
    'You triage a new card on an AgentDock Board. Your answer is shown to a person as hints they may apply or dismiss; it changes nothing by itself.',
    'Answer with one JSON object and nothing else:',
    '{"duplicates": [{"number": <an open card number from the list>, "reason": "<one short sentence>"}], "kind": {"value": "bug" | "feature", "reason": "<one short sentence>"}, "priority": {"value": "high" | "normal" | "low", "reason": "<one short sentence>"}}',
    'A duplicate asks for the same change as the new card, not merely the same area. List none when unsure.',
    'kind: "bug" when something that should work does not; otherwise "feature".',
    'priority: "high" when it blocks work, loses data, breaks security or production; "low" for polish nobody waits for; otherwise "normal".',
    'Write reasons in English.',
    '',
    '## New card',
    `Title: ${input.card.title}`,
    `Kind now: ${input.card.kind}`,
    excerpt(input.card.body) || '(no description)',
    '',
    '## Open cards of the project',
    ...(input.open.length > 0
      ? input.open.map(
          (c) =>
            `- C-${c.number} (${c.column}): ${c.title}${c.body ? ` — ${excerpt(c.body).replace(/\s+/g, ' ')}` : ''}`,
        )
      : ['(none)']),
  ].join('\n');
