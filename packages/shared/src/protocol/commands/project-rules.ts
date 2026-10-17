import { z } from 'zod';
import {
  PROJECT_RULE_DESCRIPTION_MAX,
  PROJECT_RULE_TITLE_MAX,
} from '../../project-rules/contracts';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';

/**
 * The coding-rule scan (#584, stack S-2). The control plane never reads a
 * project's files (ADR-0001), so the runner reads the conventions a project
 * already documents — its agent and contributing guides, lint and format
 * configs — and answers candidate rules. Extraction is deterministic: list
 * items of the guides and a small mapping of well-known config options, no
 * model call. Nothing is stored: the API shows the candidates and creates
 * rules only from the ones a person accepts.
 */

/** Reading a few small files at the root; no git, no `gh`. */
export const PROJECT_SCAN_RULES_TIMEOUT_MS = 15_000;
/** A file larger than this is skipped unread. */
export const RULE_SCAN_FILE_MAX_BYTES = 256 * 1024;
/** At most this many candidates come from one file, and from one scan. */
export const RULE_SCAN_PER_FILE_MAX = 40;
export const RULE_SCAN_CANDIDATES_MAX = 100;
/** The `source` of a candidate: a file name relative to the root. */
export const RULE_SCAN_SOURCE_MAX = 200;

/**
 * `project.scan_rules`: the same argument as `project.inspect`, so the
 * connect dialog can scan before anything is stored, and the Rules screen can
 * rescan a connected project's root.
 */
export const projectScanRulesArgsSchema = z.strictObject({
  path: absolutePathSchema,
});
export type ProjectScanRulesArgs = z.infer<typeof projectScanRulesArgsSchema>;

export const ruleCandidateSchema = z.object({
  title: z.string().trim().min(1).max(PROJECT_RULE_TITLE_MAX),
  description: z.string().max(PROJECT_RULE_DESCRIPTION_MAX),
  /** The file it was read from, relative to the root (`CLAUDE.md`, `biome.json`). */
  source: z.string().min(1).max(RULE_SCAN_SOURCE_MAX),
});
export type RuleCandidate = z.infer<typeof ruleCandidateSchema>;

export const projectScanRulesResultSchema = z.object({
  /** In file order, then document order; no two share a title (`ruleTitleKey`). */
  candidates: z.array(ruleCandidateSchema).max(RULE_SCAN_CANDIDATES_MAX),
  /** The files read, relative to the root. */
  scanned: z.array(z.string().min(1)),
  /** Files skipped and why (too large, not valid JSON). */
  warnings: z.array(z.string()),
});
export type ProjectScanRulesResult = z.infer<
  typeof projectScanRulesResultSchema
>;

/** Admin only, as `project.inspect`: it takes any path the policy allows. */
export const projectRuleCommands = {
  'project.scan_rules': {
    args: projectScanRulesArgsSchema,
    result: projectScanRulesResultSchema,
    minRole: 'admin',
    timeoutMs: PROJECT_SCAN_RULES_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;

export type ProjectRuleCommandName = keyof typeof projectRuleCommands;
