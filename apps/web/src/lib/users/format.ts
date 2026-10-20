import type { AdminUser, Role, UserStatus } from '@nautelle/shared';

/**
 * The tab the Users page opens on: Active, or the first tab that has rows.
 * Pending carries a warn count on its tab, so a waiting approval is seen.
 */
export function defaultUsersTab(
  counts: Record<UserStatus, number>,
): UserStatus {
  const order: UserStatus[] = ['active', 'pending', 'disabled', 'rejected'];
  return order.find((status) => counts[status] > 0) ?? 'active';
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
};

/** What each role may do (spec 10 D11), one line beside the role select. */
export const ROLE_HINT: Record<Role, string> = {
  admin:
    'Every project, and Admin: users, runners, integrations, budgets, audit.',
  operator:
    'Starts and stops work on the projects they are a member of. No Admin pages.',
  viewer: 'Reads the projects they are a member of. Cannot start anything.',
};

/**
 * A role change that adds or removes admin rights waits for a confirmation:
 * it opens or closes every project and every Admin page at once.
 */
export const roleChangeNeedsConfirm = (from: Role, to: Role): boolean =>
  from !== to && (from === 'admin' || to === 'admin');

export function roleChangeCopy(
  user: Pick<AdminUser, 'email'>,
  to: Role,
): { title: string; text: string; verb: string } {
  return to === 'admin'
    ? {
        title: 'Make this user an admin?',
        text: `${user.email} will see and manage every project and every Admin page: users, runners, integrations, budgets and audit.`,
        verb: 'Make admin',
      }
    : {
        title: 'Remove admin rights?',
        text: `${user.email} becomes ${ROLE_LABEL[to].toLowerCase()} and keeps only the projects they are a member of. Admin pages close for them at once.`,
        verb: `Make ${ROLE_LABEL[to].toLowerCase()}`,
      };
}

/** What deleting an account removes, and what stays (the schema's cascades). */
export const deleteUserCopy = (user: Pick<AdminUser, 'email'>): string =>
  `${user.email} is signed out and removed, with their project memberships, notification settings, Telegram link, personal budgets and the schedules they created. Work they did — sessions, runs, approvals, audit records — stays. Disable the account instead to keep everything.`;

/** Rule R1: why the viewer's own row has no Disable or Delete. */
export const OWN_ROW_REASON =
  'This is your own account. Another admin can disable or delete it.';
