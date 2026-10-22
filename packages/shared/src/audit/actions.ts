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
  /**
   * C-108: a runner's live socket was closed 4409 by a newer connection with
   * its token — `meta` holds both peers' IP and user agent.
   */
  'runner.connection_replaced',
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
  /** A GitHub App delivery found the project's repository under a new name. */
  'project.repo_rename',
  /**
   * #751 B9, B12: a prefix overlay proposed, approved, rejected or turned into
   * a pull-request card — `meta.change`, `meta.part`; never the content.
   */
  'project.prefix_overlay',
  'prices.version_create',
  'prices.recompute',
  'issue.create',
  'issue.queue',
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
  /** C-147: a chat redeemed a link code and waits for confirmation in the app (`after: { username }`). */
  'telegram.link_request',
  /** C-147: the user turned a waiting chat away in the app. */
  'telegram.link_decline',
  'telegram.unlink',
  'telegram.approval',
  'telegram.project',
  /** #576: a Move, Run or Stop from the Board in Telegram (`after: { action, number }`, denied when the role fell short). */
  'telegram.board',
  /** #578: a card's review action from Telegram (`after: { number, action }`). */
  'telegram.card',
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
  /** #409, DA-16: a New work split confirmed, by the person who confirmed it. */
  'plan.split_confirmed',
  /** #592 (ADR-0058): a New work candidate edited by hand (`meta.candidateId`). */
  'plan.candidate_edited',
  /** #592: a New work candidate rejected; no card was made. */
  'plan.candidate_rejected',
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
  /** #480: a stack made from a confirmed intake (`after: { number, title, stages, cards, design }`). */
  'stack.created',
  /** #480: a stack's title or body, or the cards of its stages, changed. */
  'stack.updated',
  /** #652: Run stack queued the stack's To Do cards (`after: { number, cards }`). */
  'stack.run_started',
  /** #652: a refused start or a failed round paused the stack run (`after: { number, card, error }`). */
  'stack.run_paused',
  /** #652: Stop removed the stack run's queue (`after: { number, removed }`). */
  'stack.run_stopped',
  'card.deleted',
  'card.moved',
  'card.run_started',
  'card.feedback',
  'card.finished',
  // #750 D9: the worker's `escalate_card` (reason, model, relaunched).
  'card.escalated',
  'card.accepted',
  'card.stopped',
  /** #243 D10: the card's Continue after design switch. */
  'card.design_continue_toggled',
  /** #244 D12: a suggestion landed in the Inbox (system actor, `meta.captureId`). */
  'card.captured',
  'card.inbox_accepted',
  'card.dismissed',
  /**
   * #273 D16: Accept merged the card's PR (`after: { pr, method, mergeCommit?, issueClosed }`).
   * #359 D7: also the auto-merge, by the system actor.
   */
  'card.merged',
  /** #273 D16: the runner refused the merge (`after: { pr, reason }`, result error). */
  'card.merge_failed',
  /** #329 D8: Accept closed the card's PR without merging (`after: { pr, alreadyClosed, branchDeleted, issueClosed }`). */
  'card.pr_closed',
  /** #329 D8: the runner refused to close the PR (`after: { pr, reason }`, result error). */
  'card.pr_close_failed',
  /** #329 D5: a person's Create pull request (`after: { state, pr? }`, result error when it failed). */
  'card.collect_requested',
  /**
   * #273 D9: approving the design did not start the worker (`after: { code }`).
   * #443: nor did Auto-run when ready (`after: { code, after }`).
   */
  'card.auto_run_failed',
  /**
   * #484: a card PR's head got no checks, and its pull-request event was sent
   * again — closed and reopened (`after: { number, pr, headSha, error? }`).
   */
  'card.ci_retriggered',
  /**
   * #636: the dependency a card's PR was stacked on merged, and the PR was
   * moved onto the project base (`after: { number, pr, from, base,
   * dependency }`).
   */
  'card.pr_retargeted',
  /**
   * #709: a stacked PR merged into its dependency's branch after that
   * branch's own PR had merged; a forward PR of the card's branch was opened
   * into the project base (`after: { number, pr, mergedPr, into, base,
   * dependency, alreadyOpen, conflict }`).
   */
  'card.pr_forwarded',
  /** #443: the card's Auto-run when ready switch (`after: { autoRunWhenReady }`). */
  'card.auto_run_toggled',
  /**
   * #489 M1: a person's message to a running session, or an answer to its
   * question selector (`after: { target, kind, index?, textSha256?, textChars?, via, outcome? }`;
   * the text itself never). `card.message` for a card round, `slot.session_message`
   * for a fleet slot.
   */
  'card.message',
  'slot.session_message',
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
  /**
   * ADR-0059: a provider key set or replaced — `after: { suffix }`, never the
   * key; `before` holds the replaced key's suffix.
   */
  'llm.key_set',
  /** ADR-0059: a provider key deleted (`before: { suffix }`). */
  'llm.key_deleted',
  /** ADR-0059: a stored provider key tested (`result`, `meta.error`). */
  'llm.key_tested',
  /** ADR-0059: a provider's cap or enabled models changed. */
  'llm.provider_updated',
  /** ADR-0059: the instance default model changed. */
  'llm.default_model_set',
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

/**
 * Why a login was refused — `meta.reason` of a denied `auth.login` (D9).
 * `throttled`: the source must wait after its own failures (C-109). `locked`
 * only appears in records written before C-109 removed the account lock.
 * `telegram_*`: a Mini App sign-in (#580) with unsigned or stale `initData`,
 * or from a Telegram user no account is linked to.
 */
export const LOGIN_DENIED_REASONS = [
  'invalid_credentials',
  'throttled',
  'locked',
  'pending_approval',
  'telegram_invalid',
  'telegram_not_linked',
] as const;
export type LoginDeniedReason = (typeof LOGIN_DENIED_REASONS)[number];
