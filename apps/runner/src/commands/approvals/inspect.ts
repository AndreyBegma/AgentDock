import { type CheckRollupEntry, rollupChecks } from '@agentdock/shared';
import {
  PR_INSPECT_BODY_MAX_BYTES,
  PR_INSPECT_FILES_MAX,
  PR_INSPECT_TIMEOUT_MS,
  type PrCheck,
  type PrInspectArgs,
  type PrInspection,
  type PrInspectState,
  prInspectionSchema,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { type Clock, isoNow } from '../../clock';
import { resolveFleetProject } from '../../fleet/project';
import { CommandFailure } from '../failure';
import { type DecideDeps, projectRootOf } from './decide';

/** Under the command's own 30 s, so a stuck `gh` fails here with a message. */
export const GH_INSPECT_TIMEOUT_MS = PR_INSPECT_TIMEOUT_MS - 2_000;

export const GH_INSPECT_FIELDS =
  'additions,deletions,changedFiles,files,statusCheckRollup,mergeable,mergeStateStatus,url,title,body,state,headRefOid';

export interface InspectDeps extends DecideDeps {
  clock: Clock;
}

const rollupEntrySchema = z.looseObject({
  name: z.string().nullish(),
  context: z.string().nullish(),
  workflowName: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
  detailsUrl: z.string().nullish(),
  targetUrl: z.string().nullish(),
});

const viewSchema = z.looseObject({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  files: z
    .array(
      z.looseObject({
        path: z.string().min(1),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  statusCheckRollup: z.array(rollupEntrySchema).nullish(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  url: z.string(),
  title: z.string(),
  body: z.string().default(''),
  state: z.string(),
  headRefOid: z.string(),
});

const STATES: Record<string, PrInspectState> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
};

/** `body` cut to `maxBytes` of UTF-8, never in the middle of a character. */
export const trimBytes = (text: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder('utf-8')
    .decode(bytes.subarray(0, maxBytes))
    .replace(/�$/, '');
};

const checkOf = (entry: z.infer<typeof rollupEntrySchema>): PrCheck => {
  const verdict = rollupChecks([entry]);
  const url = entry.detailsUrl || entry.targetUrl || undefined;
  return {
    name: entry.name || entry.context || entry.workflowName || 'check',
    state: verdict === 'green' ? 'pass' : verdict === 'red' ? 'fail' : 'wait',
    ...(url ? { url } : {}),
  };
};

/**
 * `pr.inspect` (spec 20 D4): `gh pr view <n> --repo <owner/name> --json …`.
 * Fixed argv, the PR is the validated integer, and nothing is read from the
 * project's files.
 */
export const prInspect = async (
  args: PrInspectArgs,
  deps: InspectDeps,
): Promise<PrInspection> => {
  const root = projectRootOf(args, deps);
  const fleet = await resolveFleetProject(deps.exec, {
    id: args.projectId,
    root,
  });
  if (!fleet.github) {
    throw new CommandFailure(
      'not_a_repository',
      `${root} has no GitHub remote`,
    );
  }
  const result = await deps.exec(
    'gh',
    [
      'pr',
      'view',
      String(args.pr),
      '--repo',
      fleet.github,
      '--json',
      GH_INSPECT_FIELDS,
    ],
    { timeoutMs: GH_INSPECT_TIMEOUT_MS },
  );
  if (!result) {
    throw new CommandFailure(
      'upstream_unavailable',
      'gh is not installed, or did not answer',
    );
  }
  if (result.code !== 0) {
    throw new CommandFailure(
      'upstream_unavailable',
      `gh pr view failed: ${result.stderr.trim().slice(0, 300)}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new CommandFailure(
      'upstream_unavailable',
      'gh pr view returned no JSON',
    );
  }
  const view = viewSchema.safeParse(raw);
  if (!view.success) {
    throw new CommandFailure(
      'upstream_unavailable',
      'gh pr view returned an unexpected shape',
    );
  }
  const pr = view.data;
  const entries = pr.statusCheckRollup ?? [];
  const state = STATES[pr.state.toUpperCase()];
  if (!state) {
    throw new CommandFailure(
      'upstream_unavailable',
      `unknown PR state ${pr.state}`,
    );
  }

  const parsed = prInspectionSchema.safeParse({
    number: args.pr,
    url: pr.url,
    title: pr.title,
    body: trimBytes(pr.body, PR_INSPECT_BODY_MAX_BYTES),
    state,
    headSha: pr.headRefOid,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    files: pr.files.slice(0, PR_INSPECT_FILES_MAX).map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
    })),
    filesTruncated: pr.files.length > PR_INSPECT_FILES_MAX,
    checks: rollupChecks(entries as CheckRollupEntry[]),
    checkList: entries.map(checkOf),
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    fetchedAt: isoNow(deps.clock),
  });
  if (!parsed.success) {
    throw new CommandFailure(
      'upstream_unavailable',
      'gh pr view returned a PR this runner cannot describe',
    );
  }
  return parsed.data;
};
