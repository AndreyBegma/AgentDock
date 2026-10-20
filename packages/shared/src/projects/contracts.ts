import type { Role } from '../auth';
import type {
  BaseSource,
  DocsCandidate,
  DocsClassified,
  DocsEvidence,
  DocsRule,
  DocsSourceKind,
  RunnerCommands,
  Runtime,
} from '../protocol';
import type { RunnerStatus } from '../runners';

/** Stable codes in the `error` field of a projects route's error body. */
export const PROJECT_ERROR = {
  notFound: 'not_found',
  forbidden: 'forbidden',
  /** The runner has no open socket; nothing was sent. */
  runnerOffline: 'runner_offline',
  /** The command was sent and no result came back in time. */
  runnerTimeout: 'runner_timeout',
  /** The runner answered with an error not mapped to its own code. */
  runnerError: 'runner_error',
  /** The runner's hello says it does not serve the command (ADR-0023). */
  runnerOutdated: 'runner_outdated',
  /** The path does not exist, or is not a directory. */
  pathNotFound: 'path_not_found',
  /** The path is not inside a git working tree. */
  notARepository: 'not_a_repository',
  /** The path is outside what the runner allows (a symlink out, an unwatched root). */
  pathNotAllowed: 'path_not_allowed',
  /** ADR-0047: the path is outside the runner policy's `allowedRoots`. */
  policyRefused: 'policy_refused',
  /** A linked worktree or subdirectory; `suggestedPath` is the main checkout. */
  notMainCheckout: 'not_main_checkout',
  /** `origin` is not on GitHub, or there is no `origin` (ADR-0004). */
  unsupportedForge: 'unsupported_forge',
  /** This runner already has a project at that root. */
  alreadyConnected: 'already_connected',
  /** `defaultProfileId` is not a profile of the project's runner. */
  profileNotOnRunner: 'profile_not_on_runner',
  /** A docs-source override whose fields do not fit its `kind`. */
  invalidDocsSource: 'invalid_docs_source',
  userNotFound: 'user_not_found',
  /** Only `active` users can be added as members. */
  userNotActive: 'user_not_active',
  alreadyMember: 'already_member',
} as const;
export type ProjectErrorCode =
  (typeof PROJECT_ERROR)[keyof typeof PROJECT_ERROR];

export interface ProjectErrorBody {
  statusCode: number;
  error: ProjectErrorCode;
  message: string;
  /** With `not_main_checkout`: the main checkout to connect instead. */
  suggestedPath?: string;
}

export const PROJECT_DISPLAY_NAME_MAX_LENGTH = 100;
export const PROJECT_LABEL_MAX_LENGTH = 100;
export const PROJECT_BRANCH_MAX_LENGTH = 255;
export const PROJECT_PATH_MAX_LENGTH = 4096;

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

/** Whether `role` meets `minRole` (viewer < operator < admin). */
export const projectRoleAtLeast = (role: Role, minRole: Role): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[minRole];

/**
 * A member's role on a project (spec 10 D11): the lower of the global role and
 * the override, so an override can only lower it. Admins bypass membership and
 * are admin on every project; that rule lives with the caller.
 */
export const effectiveProjectRole = (
  globalRole: Role,
  override: Role | null,
): Role =>
  override !== null && ROLE_RANK[override] < ROLE_RANK[globalRole]
    ? override
    : globalRole;

/** The docs source as stored: the detection result, or an admin's override. */
export interface DocsSourceView {
  kind: DocsSourceKind;
  localPath: string | null;
  repo: string | null;
  isGitRepo: boolean;
  /** Null for `none` and for a manual source. */
  detectedBy: DocsRule | null;
  evidence: DocsEvidence[];
  classified: DocsClassified;
  candidates: DocsCandidate[];
  /** Set by `PUT /projects/:id/docs-source`; a refresh leaves it alone. */
  manual: boolean;
  /**
   * #379: the Spec folder, relative to the docs root — where card and plan
   * specs are written. `null` until it is set; a refresh leaves it alone.
   */
  specDir: string | null;
  updatedAt: string;
}

/** A row of `GET /projects` — what the list and the switcher show. */
export interface ProjectSummary {
  id: string;
  displayName: string;
  repo: string;
  rootPath: string;
  runnerId: string;
  runnerName: string;
  runnerStatus: RunnerStatus;
  /** `baseOverride` when set, else the detected `baseBranch`. */
  base: string;
  docsKind: DocsSourceKind | null;
  /** The caller's effective role on this project (D11). */
  role: Role;
  /**
   * #691: why the runner's local policy refuses to watch this project, as the
   * runner worded it (ADR-0047) — the rule, the reason and the command to run
   * on its machine. Null while the runner watches it.
   */
  watchRefusal: string | null;
}

/** `GET /projects/:id`, and every route that changes a project. */
export interface ProjectDetail extends ProjectSummary {
  baseBranch: string;
  baseSource: BaseSource;
  baseOverride: string | null;
  readyLabelOverride: string | null;
  defaultProfileId: string | null;
  mergeApproval: boolean;
  codeSentinelConfig: {
    orchestrator?: Record<string, unknown>;
    error?: string;
  } | null;
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
  lastInspectedAt: string;
  createdAt: string;
  updatedAt: string;
  docsSource: DocsSourceView | null;
  /** ADR-0021; optional until the API returns them (spec 201). */
  shipSessionContent?: boolean;
  sessionContentRetentionDays?: number;
  /** What the project's runner said it serves in its latest hello (#233); null = unknown. Names only, never paths or versions. */
  runnerCommands: RunnerCommands | null;
}

/** A row of `GET /projects/:id/members`. */
export interface ProjectMemberView {
  userId: string;
  email: string;
  name: string | null;
  globalRole: Role;
  roleOverride: Role | null;
  /** `min(globalRole, roleOverride)`. */
  effectiveRole: Role;
  createdAt: string;
}

/**
 * A row of `GET /projects/:id/runtime-profiles` (operator+): a profile of the
 * project's runner present in its latest `hello`. No binary, env or args —
 * those carry machine paths and stay on the admin runner page.
 */
export interface ProjectRuntimeProfile {
  /** The profile `id` in the runner config. */
  key: string;
  runtime: Runtime;
  label: string;
  authenticated: boolean;
  /** The project's `defaultProfileId` points at this profile. */
  isDefault: boolean;
  /**
   * #445 D6: the MCP servers in the profile's own Claude config, by name —
   * what the Token saver allowlist picks from. Absent means unknown: a runner
   * older than the field, or a Codex profile.
   */
  mcpServers?: string[];
}

/** `POST /admin/projects/inspect`. Answers a `ProjectInspection`. */
export interface InspectProjectRequest {
  runnerId: string;
  path: string;
}

/** `POST /admin/projects`. Answers a `ProjectDetail` (201). */
export interface ConnectProjectRequest {
  runnerId: string;
  path: string;
  /** Defaults to the repository name. */
  displayName?: string;
}

/** `PATCH /projects/:id` (admin). `null` clears an optional field. */
export interface UpdateProjectRequest {
  displayName?: string;
  baseOverride?: string | null;
  readyLabelOverride?: string | null;
  defaultProfileId?: string | null;
  mergeApproval?: boolean;
  /** ADR-0021. */
  shipSessionContent?: boolean;
  /** 1–365 (`SESSION_CONTENT_RETENTION_DAYS`). */
  sessionContentRetentionDays?: number;
}

/**
 * `PUT /projects/:id/docs-source` (admin). `in_repo` and `sibling_repo` need
 * an absolute `localPath` (`in_repo`: under the project root); `remote_repo`
 * needs `repo` and takes the `localPath` of a local clone (#379); `none`
 * takes neither. `specDir` (#379) is the Spec folder, relative to the docs
 * root; absent or `null` clears it.
 */
export interface DocsSourceOverrideRequest {
  kind: DocsSourceKind;
  localPath?: string;
  repo?: string;
  specDir?: string | null;
}

/** `POST /projects/:id/members` (admin). */
export interface AddProjectMemberRequest {
  userId: string;
  roleOverride?: Role | null;
}

/** `PATCH /projects/:id/members/:userId` (admin). `null` clears the override. */
export interface UpdateProjectMemberRequest {
  roleOverride: Role | null;
}
