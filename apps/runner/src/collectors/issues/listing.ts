import {
  ISSUE_BODY_MAX_BYTES,
  PULL_REQUEST_BODY_MAX_BYTES,
  type SnapshotIssue,
  type SnapshotPullRequest,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import type { Exec } from '../../detect/exec';

/** Each `gh api` call: a network round trip, well over the 5 s probe default. */
export const GH_API_TIMEOUT_MS = 30_000;
export const ISSUES_PAGE_SIZE = 100;
/** A listing longer than this many pages is cut; 3000 open issues is not a queue. */
export const ISSUES_MAX_PAGES = 30;

/** `owner/name` as GitHub spells it; anything else never reaches an API path. */
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The longest prefix of `text` that fits `maxBytes` of UTF-8, never splitting a character. */
export const truncateUtf8 = (text: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const cut = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.slice(0, maxBytes),
  );
  // A character cut in half decodes to U+FFFD at the end; drop it.
  return cut.endsWith('�') ? cut.slice(0, -1) : cut;
};

const rawItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  html_url: z.url(),
  updated_at: z.iso.datetime({ offset: true }),
  labels: z
    .array(z.union([z.string(), z.object({ name: z.string().nullish() })]))
    .nullish(),
  assignees: z.array(z.object({ login: z.string() })).nullish(),
  pull_request: z.unknown().optional(),
});

export interface ListedPage {
  issues: SnapshotIssue[];
  pullRequests: SnapshotPullRequest[];
  /** Every issue and pull request number on the page. */
  open: number[];
  /** Entries on the page, valid or not: a full page means there may be another. */
  count: number;
}

/** One page of `issues?state=open`; an entry that does not fit is dropped. Not a JSON array → null. */
export const parsePage = (stdout: string): ListedPage | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const page: ListedPage = {
    issues: [],
    pullRequests: [],
    open: [],
    count: raw.length,
  };
  for (const entry of raw) {
    const parsed = rawItemSchema.safeParse(entry);
    if (!parsed.success) continue;
    const item = parsed.data;
    page.open.push(item.number);
    if (item.pull_request !== undefined && item.pull_request !== null) {
      page.pullRequests.push({
        number: item.number,
        title: item.title,
        body: truncateUtf8(item.body ?? '', PULL_REQUEST_BODY_MAX_BYTES),
        updatedAt: item.updated_at,
        url: item.html_url,
      });
      continue;
    }
    page.issues.push({
      number: item.number,
      title: item.title,
      labels: (item.labels ?? []).flatMap((l) => {
        const name = typeof l === 'string' ? l : l.name;
        return name ? [name] : [];
      }),
      assignees: (item.assignees ?? []).map((a) => a.login),
      body: truncateUtf8(item.body ?? '', ISSUE_BODY_MAX_BYTES),
      updatedAt: item.updated_at,
      url: item.html_url,
    });
  }
  return page;
};

export interface Listing {
  issues: SnapshotIssue[];
  pullRequests: SnapshotPullRequest[];
  open: number[];
}

export type FetchResult =
  | { kind: 'unchanged' }
  | { kind: 'changed'; listing: Listing; etag: string | null }
  | { kind: 'unavailable'; reason: string };

/** `gh api -i` prints `HTTP/2.0 200 OK`, the headers, a blank line, then the body. */
export const splitResponse = (
  stdout: string,
): { status: number | null; etag: string | null; body: string } => {
  const text = stdout.replace(/^\s+/, '');
  const end = /\r?\n\r?\n/.exec(text);
  const head = end ? text.slice(0, end.index) : text;
  const body = end ? text.slice(end.index + end[0].length) : '';
  const lines = head.split(/\r?\n/);
  const status = /^HTTP\/\S+\s+(\d{3})/.exec(lines[0] ?? '');
  const etag = lines
    .map((l) => /^etag:\s*(.+)$/i.exec(l)?.[1]?.trim())
    .find((v) => v);
  return {
    status: status ? Number(status[1]) : null,
    etag: etag ?? null,
    body,
  };
};

const firstLine = (text: string): string =>
  text.trim().split('\n')[0]?.slice(0, 300) ?? '';

export interface FetchOptions {
  exec: Exec;
  /** `owner/name`. */
  repo: string;
  /** Sent as `If-None-Match` on the first page; none → unconditional. */
  etag: string | null;
}

/**
 * The project's open issues and pull requests through `gh api` (D1). The
 * first page is conditional: a `304` is `unchanged` and costs no rate limit.
 * Later pages are fetched only when the first changed. Fixed argv; the repo
 * is checked before it becomes part of a path.
 */
export const fetchListing = async (
  options: FetchOptions,
): Promise<FetchResult> => {
  const { exec, repo, etag } = options;
  if (!REPO.test(repo)) {
    return { kind: 'unavailable', reason: `not a GitHub repository: ${repo}` };
  }
  const path = (page: number) =>
    `repos/${repo}/issues?state=open&per_page=${ISSUES_PAGE_SIZE}&page=${page}`;

  const conditional = etag ? ['-H', `If-None-Match: ${etag}`] : [];
  const first = await exec('gh', ['api', '-i', ...conditional, path(1)], {
    timeoutMs: GH_API_TIMEOUT_MS,
  });
  if (!first) {
    return {
      kind: 'unavailable',
      reason: 'gh is not available or timed out',
    };
  }
  const head = splitResponse(first.stdout);
  if (head.status === 304 || /HTTP 304\b/.test(first.stderr)) {
    return { kind: 'unchanged' };
  }
  if (first.code !== 0 || (head.status !== null && head.status >= 400)) {
    return {
      kind: 'unavailable',
      reason: `gh api failed: ${firstLine(first.stderr || head.body || first.stdout)}`,
    };
  }

  const listing: Listing = { issues: [], pullRequests: [], open: [] };
  let page = parsePage(head.body);
  for (let n = 1; ; n++) {
    if (!page) {
      return { kind: 'unavailable', reason: 'gh api returned no JSON array' };
    }
    listing.issues.push(...page.issues);
    listing.pullRequests.push(...page.pullRequests);
    listing.open.push(...page.open);
    if (page.count < ISSUES_PAGE_SIZE || n >= ISSUES_MAX_PAGES) break;
    const next = await exec('gh', ['api', path(n + 1)], {
      timeoutMs: GH_API_TIMEOUT_MS,
    });
    if (!next || next.code !== 0) {
      return {
        kind: 'unavailable',
        reason: `gh api failed: ${next ? firstLine(next.stderr) : 'timed out'}`,
      };
    }
    page = parsePage(next.stdout);
  }
  return { kind: 'changed', listing, etag: head.etag };
};
