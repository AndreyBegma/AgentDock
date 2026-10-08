/**
 * Every action the audit log records (docs/specs/8-audit-log.md D5). Closed on
 * purpose: a module that audits something new adds it here, where review sees it.
 */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.logout',
  'auth.register',
  'auth.password_change',
  'auth.session_revoke',
  'user.create',
  'user.approve',
  'user.reject',
  'user.update',
  'user.delete',
  'settings.registration',
  'runner.create',
  'runner.pairing_code',
  'runner.pair',
  'runner.rename',
  'runner.revoke',
  'runner.command',
  'runner.command.result',
  'project.connect',
  'project.delete',
  'project.update',
  'project.member_add',
  'project.member_update',
  'project.member_remove',
  'project.docs_source_override',
  'project.docs_source_reset',
  'prices.version_create',
  'prices.recompute',
  'issue.create',
  'orchestrator.start',
  'orchestrator.stop',
  'orchestrator.settings',
  'slot.stop',
  'slot.message',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTOR_TYPES = [
  'user',
  'runner',
  'system',
  'anonymous',
] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** `requested`: a runner command sent, its result recorded separately (D8). */
export const AUDIT_RESULTS = ['ok', 'denied', 'error', 'requested'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/** Why a login was refused — `meta.reason` of a denied `auth.login` (D9). */
export const LOGIN_DENIED_REASONS = [
  'invalid_credentials',
  'locked',
  'pending_approval',
] as const;
export type LoginDeniedReason = (typeof LOGIN_DENIED_REASONS)[number];
