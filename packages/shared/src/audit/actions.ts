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
  'runner.update',
  'local.request',
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
  'pane.watch_started',
  'pane.watch_stopped',
  'orchestrator.start',
  'orchestrator.stop',
  'orchestrator.settings',
  'orchestrator.message',
  'slot.stop',
  'slot.message',
  'approval.approve',
  'approval.request_changes',
  'approval.void',
  'notification.rules',
  'notification.mute',
  'telegram.configure',
  'telegram.clear',
  'telegram.link',
  'telegram.unlink',
  'telegram.approval',
  'terminal.attached',
  'terminal.detached',
  'skill.installed',
  'skill.uninstalled',
  'skill.run_started',
  'skill.run_cancelled',
  'skill.run_finished',
  'schedule.create',
  'schedule.update',
  'schedule.enable',
  'schedule.disable',
  'schedule.delete',
  'schedule.run_now',
  'budget.create',
  'budget.update',
  'budget.delete',
  'budget.override',
  'budget.override_revoke',
  'budget.recompute',
  'webhook.create',
  'webhook.update',
  'webhook.delete',
  'webhook.rotate_secret',
  'webhook.test',
  'webhook.redeliver',
  'webhook.circuit_close',
  'trigger.create',
  'trigger.update',
  'trigger.delete',
  'trigger.rotate_secret',
  'settings.webhooks',
  'github_app.register',
  'github_app.update_credentials',
  'github_app.resync',
  'github_app.delete',
  'plan.created',
  'plan.shared',
  'plan.revised',
  'plan.sent',
  'plan.task_reviewed',
  'planner.instructions_updated',
  'planner.settings_updated',
  'design.toggled',
  'design.generated',
  'design.revised',
  'design.approved',
  'design.settings_updated',
  /** #275 D5: `meta` `{stage, runId, turnId?}`. */
  'design.stopped',
  'uiprofile.built',
  'uiprofile.edited',
  'action_request.created',
  'action_request.decided',
  'action_request.executed',
  'session_content.purged',
  'card.created',
  'card.updated',
  'card.deleted',
  'card.moved',
  'card.run_started',
  'card.feedback',
  'card.finished',
  'card.accepted',
  'card.stopped',
  /** #243 D10: the card's Continue after design switch. */
  'card.design_continue_toggled',
  /** #244 D12: a suggestion landed in the Inbox (system actor, `meta.captureId`). */
  'card.captured',
  'card.inbox_accepted',
  'card.dismissed',
  /** #273 D16: Accept merged the card's PR (`after: { pr, method, mergeCommit?, issueClosed }`). */
  'card.merged',
  /** #273 D16: the runner refused the merge (`after: { pr, reason }`, result error). */
  'card.merge_failed',
  /** #329 D8: Accept closed the card's PR without merging (`after: { pr, alreadyClosed, branchDeleted, issueClosed }`). */
  'card.pr_closed',
  /** #329 D8: the runner refused to close the PR (`after: { pr, reason }`, result error). */
  'card.pr_close_failed',
  /** #329 D5: a person's Create pull request (`after: { state, pr? }`, result error when it failed). */
  'card.collect_requested',
  /** #273 D9: approving the design did not start the worker (`after: { code }`). */
  'card.auto_run_failed',
  /** #309 D7: an upload stored, pending (`after: { name, mime, size }`). */
  'attachment.added',
  /** #309 D7: pending uploads claimed onto a card (`after: { cardId, roundId?, attachmentIds }`). */
  'attachment.claimed',
  /** #309 D7: an attachment deleted by its uploader or an admin (`before: { name, cardId }`). */
  'attachment.removed',
  /** Also records the capture fields (#244 D12). */
  'board.settings_updated',
  /** #271 D13: the per-project "Store text in English" switch (`after: { normalizeEnabled }`). */
  'text.settings_updated',
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
