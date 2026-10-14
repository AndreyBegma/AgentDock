import {
  type PlanQuestion,
  type PlanTaskKind,
  parseDependsOn,
} from '@agentdock/shared';

/** A task as send orders and renders it. */
export interface SendTask {
  key: string;
  kind: PlanTaskKind;
  title: string;
  summary: string;
  dependsOn: string[];
  questions: PlanQuestion[];
  document: string | null;
}

/**
 * A cycle in `dependsOn`, as the keys along it (`[a, b, a]`), or null (D8).
 * Dependencies on keys outside `tasks` are ignored here.
 */
export const findCycle = (
  tasks: readonly Pick<SendTask, 'key' | 'dependsOn'>[],
): string[] | null => {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting') {
      return [...path.slice(path.indexOf(key)), key];
    }
    state.set(key, 'visiting');
    path.push(key);
    for (const dep of deps.get(key) ?? []) {
      if (!deps.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(key, 'done');
    return null;
  };
  for (const t of tasks) {
    const cycle = visit(t.key);
    if (cycle) return cycle;
  }
  return null;
};

/**
 * The keys in dependency order — every task after the tasks it depends on —
 * keeping the plan's order where the graph allows. The graph must be acyclic.
 */
export const dependencyOrder = (
  tasks: readonly Pick<SendTask, 'key' | 'dependsOn'>[],
): string[] => {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const dep of deps.get(key) ?? []) if (deps.has(dep)) visit(dep);
    order.push(key);
  };
  for (const t of tasks) visit(t.key);
  return order;
};

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const DEPENDS_LINE = /depends\s+on\b/i;

/**
 * D8: `Depends on <key>` → `Depends on #<number>` on every `Depends on` line,
 * then one `Depends on #…` line for the dependencies the body did not name,
 * so the queue (#19 D3) sees every edge of the graph.
 */
export const rewriteDependsOn = (
  body: string,
  dependsOn: readonly string[],
  numbers: ReadonlyMap<string, number>,
): string => {
  const keys = [...numbers.keys()].sort((a, b) => b.length - a.length);
  const rewritten = body
    .split('\n')
    .map((line) => {
      if (!DEPENDS_LINE.test(line) || keys.length === 0) return line;
      const pattern = new RegExp(
        `(?<![\\w#/-])\`?(${keys.map(escapeRegExp).join('|')})\`?(?![\\w-])`,
        'g',
      );
      return line.replace(pattern, (_m, key: string) => `#${numbers.get(key)}`);
    })
    .join('\n');
  const named = new Set(parseDependsOn(rewritten));
  const missing = dependsOn
    .map((key) => numbers.get(key))
    .filter((n): n is number => n !== undefined && !named.has(n));
  if (missing.length === 0) return rewritten;
  return `${rewritten.trimEnd()}\n\nDepends on ${missing.map((n) => `#${n}`).join(', ')}\n`;
};

/** A file-name slug of a title: lower-case ASCII words joined by `-`. */
export const slugOf = (title: string): string => {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug === '' ? 'task' : slug;
};

/** D10: `<specDir>/<issue>-<slug>.md`. */
export const specFilePath = (
  specDir: string,
  issue: number,
  title: string,
): string => `${specDir}/${issue}-${slugOf(title)}.md`;

/**
 * The document of a task that was approved as it is, without a written one
 * (D6, Q6): its summary and, under `## Open questions`, the defaults taken.
 */
export const fallbackDocument = (task: SendTask): string => {
  const defaults = task.questions.map(
    (q) =>
      `- **${q.title}** — ${q.question}\n  Default taken: ${q.recommendation.text} (${q.recommendation.why})`,
  );
  return [
    '## Summary',
    '',
    task.summary,
    ...(defaults.length > 0 ? ['', '## Open questions', '', ...defaults] : []),
    '',
  ].join('\n');
};

/** D4: the document send files — written, else the fallback. */
export const documentOf = (task: SendTask): string =>
  task.document ?? fallbackDocument(task);

/**
 * D10 `docs_pr`: a feature's issue body is a summary that points to its
 * specification in the plan's docs pull request. The file is named after the
 * issue, whose number does not exist yet, so the body names the directory and
 * the branch (Q3).
 */
export const docsPrIssueBody = (
  task: SendTask,
  specDir: string,
  branch: string,
): string =>
  [
    '## Summary',
    '',
    task.summary,
    '',
    '## Specification',
    '',
    `The full specification is \`${specDir}/<this issue>-${slugOf(task.title)}.md\`, added by this plan's docs pull request (branch \`${branch}\`).`,
    '',
  ].join('\n');
