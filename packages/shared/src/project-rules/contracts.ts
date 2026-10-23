import type { CardType } from '../prefix/contracts';

/**
 * Per-project coding rules (issue #528, stack S-2): short instructions a card
 * worker follows on one project. The API stores them in the control plane —
 * never in a file of the project's repository.
 */

/** The open-question defaults of #528. */
export const PROJECT_RULE_TITLE_MAX = 120;
export const PROJECT_RULE_DESCRIPTION_MAX = 4000;
/** A Markdown document `POST …/rules/import` accepts, in characters. */
export const PROJECT_RULE_IMPORT_MAX = 100_000;

/**
 * Mirrors the Prisma enum `ProjectRuleSource`: who wrote the rule — a person,
 * a Markdown import, or the scan on connect (C-226). The UI badges it.
 */
export const PROJECT_RULE_SOURCES = ['manual', 'imported', 'scanned'] as const;
export type ProjectRuleSource = (typeof PROJECT_RULE_SOURCES)[number];

export interface ProjectRuleView {
  id: string;
  projectId: string;
  title: string;
  description: string;
  enabled: boolean;
  /** 0-based; the list is served in this order. */
  position: number;
  source: ProjectRuleSource;
  /** #751 B5: the card types it applies to; empty is all. */
  appliesTo: CardType[];
  createdAt: string;
  updatedAt: string;
}

/** `POST /projects/:id/rules` — appended at the end, enabled by default. */
export interface ProjectRuleCreateRequest {
  title: string;
  /** Default `''`. */
  description?: string;
  /** Default true. */
  enabled?: boolean;
}

/** `PATCH /projects/:id/rules/:ruleId`. */
export interface ProjectRuleUpdateRequest {
  title?: string;
  description?: string;
  enabled?: boolean;
  /** #751 B5: `CARD_TYPES`, each once; empty is all. */
  appliesTo?: CardType[];
}

/** `PUT /projects/:id/rules/order` — every rule of the project, once each. */
export interface ProjectRuleReorderRequest {
  ruleIds: string[];
}

/** `POST /projects/:id/rules/import`. */
export interface ProjectRuleImportRequest {
  markdown: string;
}

export interface ProjectRuleImportResult {
  /** How many rules were created. */
  created: number;
  /** How many were skipped as duplicates by title. */
  skipped: number;
  /** The created rules, in document order. */
  rules: ProjectRuleView[];
  /** The skipped titles: already on the project, or repeated in the document. */
  skippedTitles: string[];
}

/**
 * A coding-rule candidate the scan found (#584), not stored: it becomes a
 * rule only when a person accepts it. `duplicate` marks a title already on
 * the project — as it is now, or as it was typed before its translation to
 * English — so a rescan never offers it checked.
 */
export interface ProjectRuleCandidateView {
  title: string;
  description: string;
  /** The file it was read from, relative to the project root. */
  source: string;
  duplicate: boolean;
}

/**
 * `POST /admin/projects/rule-candidates` (before connect) and
 * `POST /projects/:id/rules/scan` (a rescan).
 */
export interface ProjectRuleScanResult {
  candidates: ProjectRuleCandidateView[];
  /** The files read, relative to the root. */
  scanned: string[];
  /** Files skipped and why. */
  warnings: string[];
}

/** `POST /admin/projects/rule-candidates`: the same fields as an inspect. */
export interface ProjectRuleScanRequest {
  runnerId: string;
  path: string;
}

/** One candidate a person accepted. */
export interface ProjectRuleCandidateInput {
  title: string;
  description: string;
  source: string;
}

/**
 * `POST /projects/:id/rules/accept`: the accepted candidates become enabled
 * rules with source `scanned`, in this order; a title already on the project
 * is skipped. The answer is shaped like an import's.
 */
export interface ProjectRuleAcceptRequest {
  candidates: ProjectRuleCandidateInput[];
}

/** An accept carries at most what one scan can answer. */
export const PROJECT_RULE_ACCEPT_MAX = 100;
/** `ProjectRuleCandidateInput.source`, in characters. */
export const PROJECT_RULE_SOURCE_MAX = 200;

export const PROJECT_RULE_ERROR = {
  notFound: 'not_found',
  /** A reorder that does not list every rule of the project exactly once. */
  orderMismatch: 'rule_order_mismatch',
} as const;
export type ProjectRuleErrorCode =
  (typeof PROJECT_RULE_ERROR)[keyof typeof PROJECT_RULE_ERROR];

export interface ProjectRuleErrorBody {
  statusCode: number;
  error: ProjectRuleErrorCode;
  message: string;
}
