import type {
  DocsSourceView,
  ProjectDetail,
  ProjectMemberView,
  ProjectRuntimeProfile,
  ProjectSummary,
  Role,
  RunnerStatus,
} from '@agentdock/shared';
import {
  type DocsSource as DetectedDocsSource,
  type DocsClassified,
  docsSourceSchema,
  type ProjectInspection,
  projectInspectionSchema,
  runnerCommandsOf,
  runtimeProfileSchema,
} from '@agentdock/shared/protocol';
import type {
  DocsSource,
  Prisma,
  Project,
  ProjectMember,
  RuntimeProfile,
  User,
} from '@prisma/client';
import { z } from 'zod';

export const EMPTY_CLASSIFIED: DocsClassified = {
  specs: [],
  adr: [],
  roadmap: [],
  reports: [],
};

// The JSON columns hold what the runner reported, validated on the way in;
// parsed again on the way out so a hand-edited row cannot reach a client in a
// shape the contract does not allow.
const parsed = <T>(
  schema: {
    safeParse(v: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
  fallback: T,
): T => {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
};

const { evidence, classified, candidates } = docsSourceSchema.shape;
const configSchema = projectInspectionSchema.shape.codeSentinelConfig;

/** The `docs_sources` columns for a detected source. */
export const detectedDocsData = (docs: DetectedDocsSource) => ({
  kind: docs.kind,
  localPath: docs.localPath,
  repo: docs.repo,
  isGitRepo: docs.isGitRepo,
  detectedBy: docs.detectedBy,
  evidence: docs.evidence as Prisma.InputJsonValue,
  classified: docs.classified as Prisma.InputJsonValue,
  candidates: docs.candidates as Prisma.InputJsonValue,
  manual: false,
});

export const toDocsSourceView = (docs: DocsSource): DocsSourceView => ({
  kind: docs.kind,
  localPath: docs.localPath,
  repo: docs.repo,
  isGitRepo: docs.isGitRepo,
  detectedBy: docs.detectedBy,
  evidence: parsed(evidence, docs.evidence, []),
  classified: parsed(classified, docs.classified, EMPTY_CLASSIFIED),
  candidates: parsed(candidates, docs.candidates, []),
  manual: docs.manual,
  specDir: docs.specDir,
  updatedAt: docs.updatedAt.toISOString(),
});

export type ProjectWithRelations = Project & {
  runner: {
    id: string;
    name: string;
    revokedAt: Date | null;
    capabilities: Prisma.JsonValue;
  };
  docsSource: DocsSource | null;
};

export const toProjectSummary = (
  project: ProjectWithRelations,
  runnerStatus: RunnerStatus,
  role: Role,
): ProjectSummary => ({
  id: project.id,
  displayName: project.displayName,
  repo: project.repo,
  rootPath: project.rootPath,
  runnerId: project.runnerId,
  runnerName: project.runner.name,
  runnerStatus,
  base: project.baseOverride ?? project.baseBranch,
  docsKind: project.docsSource?.kind ?? null,
  role,
});

export const toProjectDetail = (
  project: ProjectWithRelations,
  runnerStatus: RunnerStatus,
  role: Role,
): ProjectDetail => ({
  ...toProjectSummary(project, runnerStatus, role),
  baseBranch: project.baseBranch,
  baseSource: project.baseSource,
  baseOverride: project.baseOverride,
  readyLabelOverride: project.readyLabelOverride,
  defaultProfileId: project.defaultProfileId,
  mergeApproval: project.mergeApproval,
  codeSentinelConfig:
    project.codeSentinelConfig === null
      ? null
      : parsed<ProjectInspection['codeSentinelConfig'] | null>(
          configSchema,
          project.codeSentinelConfig,
          null,
        ),
  hasClaudeMd: project.hasClaudeMd,
  hasAgentsMd: project.hasAgentsMd,
  lastInspectedAt: project.lastInspectedAt.toISOString(),
  createdAt: project.createdAt.toISOString(),
  updatedAt: project.updatedAt.toISOString(),
  docsSource: project.docsSource ? toDocsSourceView(project.docsSource) : null,
  // The latest hello's advert (#233): command names only, never the rest of
  // the capabilities (profile env and binaries, paths).
  runnerCommands: runnerCommandsOf(project.runner.capabilities),
});

export const toMemberView = (
  member: ProjectMember & { user: Pick<User, 'email' | 'name' | 'role'> },
  effectiveRole: Role,
): ProjectMemberView => ({
  userId: member.userId,
  email: member.user.email,
  name: member.user.name,
  globalRole: member.user.role,
  roleOverride: member.roleOverride,
  effectiveRole,
  createdAt: member.createdAt.toISOString(),
});

const profilesAdvertSchema = z.object({ profiles: z.array(z.unknown()) });

const profileMcpAdvertSchema = runtimeProfileSchema
  .pick({ id: true, mcpServers: true })
  .required({ mcpServers: true });

/**
 * #445 D6: each profile's MCP server names from stored capabilities JSON, by
 * profile key. Read per profile, like `profileAgentdockOf`: a profile without
 * a valid list is left out — unknown, never "none".
 */
export const profileMcpServersOf = (
  capabilities: unknown,
): ReadonlyMap<string, string[]> => {
  const parsed = profilesAdvertSchema.safeParse(capabilities);
  const out = new Map<string, string[]>();
  if (!parsed.success) return out;
  for (const entry of parsed.data.profiles) {
    const profile = profileMcpAdvertSchema.safeParse(entry);
    if (profile.success && !out.has(profile.data.id)) {
      out.set(profile.data.id, profile.data.mcpServers);
    }
  }
  return out;
};

/** Field by field on purpose: binary, env and args carry machine paths. */
export const toProjectRuntimeProfile = (
  profile: Pick<
    RuntimeProfile,
    'id' | 'key' | 'runtime' | 'label' | 'authenticated'
  >,
  defaultProfileId: string | null,
  mcpServers?: string[],
): ProjectRuntimeProfile => ({
  key: profile.key,
  runtime: profile.runtime,
  label: profile.label,
  authenticated: profile.authenticated,
  isDefault: profile.id === defaultProfileId,
  ...(mcpServers ? { mcpServers } : {}),
});
