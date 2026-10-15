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

/** Spec 223 "Open questions": where a project without a `specDir` keeps designs. */
export const DESIGN_FALLBACK_DIR = 'docs';

/** What a write turn is told before the issue exists; send fills it in. */
export const ISSUE_PLACEHOLDER = '<issue>';

/** How an issue body names a path holding its own number, which it cannot know (Q3). */
export const THIS_ISSUE = '<this issue>';

/**
 * Spec 223 D16: `<specDir>/<issue>-<slug>/design/<variant>.html`, or
 * `docs/design/<issue>-<slug>/<variant>.html` without a `specDir`.
 */
export const designFilePath = (
  specDir: string | null,
  issue: number | typeof ISSUE_PLACEHOLDER | typeof THIS_ISSUE,
  title: string,
  variant: number,
): string =>
  specDir
    ? `${specDir}/${issue}-${slugOf(title)}/design/${variant}.html`
    : `${DESIGN_FALLBACK_DIR}/design/${issue}-${slugOf(title)}/${variant}.html`;

/**
 * Spec 223 D16: the document names its design file with the real issue
 * number. The write turn wrote the path with `<issue>`; a document that does
 * not name the file at all gets a `## Design` section that does.
 */
export const withDesignPath = (
  document: string,
  template: string,
  path: string,
): string => {
  const filled = document.split(template).join(path);
  if (filled.includes(path)) return filled;
  return `${filled.trimEnd()}\n\n## Design\n\nThe approved mockup is \`${path}\`. It fixes the layout, the states and the copy; it is not code to copy — build it with the project's real components.\n`;
};

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
  designVariant: number | null = null,
): string =>
  [
    '## Summary',
    '',
    task.summary,
    '',
    '## Specification',
    '',
    `The full specification is \`${specDir}/${THIS_ISSUE}-${slugOf(task.title)}.md\`, added by this plan's docs pull request (branch \`${branch}\`).`,
    ...(designVariant !== null
      ? [
          '',
          `Its approved design is \`${designFilePath(specDir, THIS_ISSUE, task.title, designVariant)}\`, in the same pull request.`,
        ]
      : []),
    '',
  ].join('\n');
