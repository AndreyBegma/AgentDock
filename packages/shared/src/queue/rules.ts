/**
 * Reading an issue body the way the orchestrator's Phase 2 does (spec 19 D3,
 * D7). One implementation for the API, the runner and the web app, so the
 * three never disagree about whether an issue is dispatchable.
 *
 * Every parser ignores fenced code blocks: a body that quotes `Depends on #3`
 * in an example is not blocked by it.
 */

/** The label the orchestrator reads when the project and its config name none. */
export const DEFAULT_READY_LABEL = 'cs:ready';
/** Labels the orchestrator itself sets (orchestrator Phase 1). */
export const IN_FLIGHT_LABEL = 'cs:in-flight';
export const NEEDS_PERSON_LABEL = 'cs:needs-person';
/** Labels a new issue may carry even before the repository has used them (D7). */
export const ALWAYS_ALLOWED_LABELS = ['enhancement', 'bug'] as const;

const FENCE = /^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm;

const withoutCode = (body: string): string => body.replace(FENCE, '');

const lines = (body: string): string[] =>
  withoutCode(body.replace(/\r\n?/g, '\n')).split('\n');

/** Leading list, quote and bold markers of a line: `- **Gate:**` → `Gate:**`. */
const LEAD = String.raw`^\s*(?:[-*+>]\s+)*(?:\*\*|__)?`;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+\S/;

/** `#n` not preceded by `owner/repo` or a word: another repository's issue is not ours. */
const ISSUE_REF = /(?<![\w/.-])#(\d+)\b/g;

const issueRefs = (text: string): number[] =>
  [...text.matchAll(ISSUE_REF)].map((m) => Number(m[1]));

const unique = (numbers: number[]): number[] =>
  [...new Set(numbers)].sort((a, b) => a - b);

const DEPENDS_ON = new RegExp(`${LEAD}depends\\s+on\\b(.*)$`, 'i');

/** Every `#m` on a `Depends on` line, ascending. */
export const parseDependsOn = (body: string): number[] =>
  unique(
    lines(body).flatMap((line) => {
      const match = DEPENDS_ON.exec(line);
      return match ? issueRefs(match[1]) : [];
    }),
  );

const GATE = new RegExp(
  `${LEAD}gate(?:\\*\\*|__)?\\s*:(?:\\*\\*|__)?\\s*(.*)$`,
  'i',
);
const NO_GATE = /^(?:none|no|n\/a|-|—|–)?\.?$/i;

/** The first `Gate:` line that names a gate, trimmed; null when there is none. */
export const parseGate = (body: string): string | null => {
  for (const line of lines(body)) {
    const match = GATE.exec(line);
    if (!match) continue;
    const gate = match[1].replace(/[`*_]+$/, '').trim();
    if (!NO_GATE.test(gate)) return line.trim();
  }
  return null;
};

interface Section {
  title: string;
  /** The lines up to the next heading of the same or a higher level. */
  body: string[];
}

const sections = (body: string): Section[] => {
  const all = lines(body);
  const found: Section[] = [];
  all.forEach((line, i) => {
    const heading = HEADING.exec(line);
    if (!heading) return;
    const level = heading[1].length;
    const rest: string[] = [];
    for (const next of all.slice(i + 1)) {
      const h = HEADING.exec(next);
      if (h && h[1].length <= level) break;
      rest.push(next);
    }
    found.push({ title: heading[2], body: rest });
  });
  return found;
};

const titled = (body: string, title: RegExp): Section[] =>
  sections(body).filter((s) => title.test(s.title));

const ACCEPTANCE = /^acceptance\s+criteria\b/i;
/** `**Acceptance criteria**` or `Acceptance criteria:` as a plain line, not a heading. */
const ACCEPTANCE_LINE = new RegExp(
  `${LEAD}acceptance\\s+criteria\\b[^\\n]*$`,
  'i',
);

/**
 * D3: a `## Acceptance criteria` section with at least one checkbox item, or
 * an `Acceptance criteria` line followed by a checkbox list.
 */
export const hasAcceptanceCriteria = (body: string): boolean => {
  if (
    titled(body, ACCEPTANCE).some((s) => s.body.some((l) => CHECKBOX.test(l)))
  )
    return true;
  const all = lines(body);
  return all.some((line, i) => {
    if (HEADING.test(line) || !ACCEPTANCE_LINE.test(line)) return false;
    const next = all.slice(i + 1).find((l) => l.trim() !== '');
    return next !== undefined && CHECKBOX.test(next);
  });
};

const REPRODUCTION = /^(?:steps\s+to\s+reproduce|reproduction)\b/i;

/** A `## Steps to reproduce` / `## Reproduction` section with content (D3, bugs). */
export const hasReproduction = (body: string): boolean =>
  titled(body, REPRODUCTION).some((s) => s.body.some((l) => l.trim() !== ''));

const PARALLEL_PLAN = /^parallel\s+plan\b/i;

export const hasParallelPlan = (body: string): boolean =>
  titled(body, PARALLEL_PLAN).length > 0;

/** One row of an issue's `## Parallel plan` table (D5). */
export interface WaveSlot {
  slot: string;
  lead: boolean;
  model: string | null;
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim().replace(/^`|`$/g, ''));

/** A slot name: what dispatch accepts, and what the `Depends on` cell may list. */
const WAVE_SLOT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The first contiguous run of `|` lines; later tables are not the plan. */
const firstTable = (section: string[]): string[] => {
  const start = section.findIndex((l) => l.trim().startsWith('|'));
  if (start < 0) return [];
  const rest = section.slice(start);
  const end = rest.findIndex((l) => !l.trim().startsWith('|'));
  return end < 0 ? rest : rest.slice(0, end);
};

/** The `## Parallel plan` table: lower-cased header and data rows; null without a plan. */
const parallelPlanTable = (
  body: string,
): { col: (name: string) => number; rows: string[][] } | null => {
  const [plan] = titled(body, PARALLEL_PLAN);
  if (!plan) return null;
  const lines = firstTable(plan.body);
  if (lines.length < 2) return { col: () => -1, rows: [] };
  const header = cells(lines[0]).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const slot = col('slot');
  const rows =
    slot < 0
      ? []
      : lines
          .slice(1)
          .map(cells)
          .filter(
            (r) =>
              !r.every((c) => /^:?-+:?$/.test(c)) &&
              WAVE_SLOT_NAME.test(r[slot] ?? ''),
          );
  return { col, rows };
};

/** The slots of the `## Parallel plan` table; null when the body has no plan. */
export const parseParallelPlan = (body: string): WaveSlot[] | null => {
  const table = parallelPlanTable(body);
  if (!table) return null;
  const slot = table.col('slot');
  const lead = table.col('lead');
  const model = table.col('model');
  return table.rows.map((r) => ({
    slot: r[slot],
    lead: lead >= 0 && /^(?:yes|true|✓|x)$/i.test(r[lead] ?? ''),
    model: model >= 0 && r[model] ? r[model] : null,
  }));
};

/**
 * The `Depends on` column of the `## Parallel plan` table: slot → the slots of
 * the same plan it waits for (#160's wave edges). A cell lists slot names
 * separated by commas or spaces; `—`, `-`, `none` and names not in the table
 * are dropped. Every slot of the table has an entry; null without a plan.
 */
export const parseWaveDependencies = (
  body: string,
): Map<string, string[]> | null => {
  const table = parallelPlanTable(body);
  if (!table) return null;
  const slot = table.col('slot');
  const depends = table.col('depends on');
  const slots = new Set(table.rows.map((r) => r[slot]));
  return new Map(
    table.rows.map((r) => {
      const cell = depends >= 0 ? (r[depends] ?? '') : '';
      const names = cell
        .split(/[\s,;]+/)
        .map((n) => n.replace(/^`|`$/g, ''))
        .filter((n) => WAVE_SLOT_NAME.test(n) && slots.has(n) && n !== r[slot]);
      return [r[slot], [...new Set(names)]];
    }),
  );
};

const SIZE_NEEDS_PLAN = /^size:\s*(?:xl|xxl)$/i;

/** Why an issue is `NO SPEC` (D3), or why a new one may not be queued (D7). */
export type SpecGap = 'no_acceptance_criteria' | 'no_parallel_plan';

export const SPEC_GAP_TEXT: Record<SpecGap, { why: string; clears: string }> = {
  no_acceptance_criteria: {
    why: 'the body does not say what done looks like — no acceptance criteria',
    clears:
      'an `## Acceptance criteria` section with `- [ ]` items (or `## Steps to reproduce` for a bug) — /code-sentinel:spec',
  },
  no_parallel_plan: {
    why: 'sized XL or larger without a `## Parallel plan`',
    clears: 'split it into a `## Parallel plan` — /code-sentinel:spec',
  },
};

/**
 * D3's `NO SPEC` rule, which D7 also applies before queueing a new issue: the
 * body states what done looks like (acceptance criteria, or a reproduction for
 * a `bug`), and an XL/XXL issue carries a parallel plan. Null when complete.
 */
export const specGap = (
  body: string,
  labels: readonly string[],
): SpecGap | null => {
  const isBug = labels.some((l) => l.toLowerCase() === 'bug');
  if (!hasAcceptanceCriteria(body) && !(isBug && hasReproduction(body)))
    return 'no_acceptance_criteria';
  if (labels.some((l) => SIZE_NEEDS_PLAN.test(l)) && !hasParallelPlan(body))
    return 'no_parallel_plan';
  return null;
};

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+/gi;

/** Issues a pull request body closes (`Closes #n`, `Fixes #n`, `Resolves #n`). */
export const parseClosingRefs = (body: string): number[] => {
  const text = withoutCode(body);
  const found: number[] = [];
  for (const match of text.matchAll(CLOSING)) {
    const rest = text.slice((match.index ?? 0) + match[0].length);
    const ref = /^#(\d+)\b/.exec(rest);
    if (ref) found.push(Number(ref[1]));
  }
  return unique(found);
};

/** `*\/<n>-*`: the branch naming convention of cs-feature and the orchestrator. */
export const branchIssue = (branch: string): number | null => {
  const match = /\/(\d+)-/.exec(branch);
  return match ? Number(match[1]) : null;
};

export const QUEUE_PRIORITIES = ['critical', 'high', 'medium'] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

/** `priority: <level>` from the labels; the highest one when several (D6). */
export const priorityOf = (labels: readonly string[]): QueuePriority | null => {
  const levels = labels
    .map((l) => /^priority:\s*(\w+)$/i.exec(l.trim())?.[1]?.toLowerCase())
    .filter((p): p is QueuePriority =>
      (QUEUE_PRIORITIES as readonly string[]).includes(p ?? ''),
    );
  return QUEUE_PRIORITIES.find((p) => levels.includes(p)) ?? null;
};

/** D6: `critical` < `high` < `medium` < none, then the lower number first. */
export const comparePriority = (
  a: { priority: QueuePriority | null; number: number },
  b: { priority: QueuePriority | null; number: number },
): number => {
  const rank = (p: QueuePriority | null) =>
    p === null ? QUEUE_PRIORITIES.length : QUEUE_PRIORITIES.indexOf(p);
  return rank(a.priority) - rank(b.priority) || a.number - b.number;
};
