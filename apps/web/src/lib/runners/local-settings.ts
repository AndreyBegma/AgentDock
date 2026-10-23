import type { AdminUser } from '@nautelle/shared';

/** "Ann (ann@example.com)", or the email alone for a user with no name. */
export const userOptionLabel = (
  user: Pick<AdminUser, 'email' | 'name'>,
): string => (user.name ? `${user.name} (${user.email})` : user.email);

/**
 * The options of the local-user selector: every active user, plus the saved
 * one when it is not among them (a user since rejected still has to show, or
 * the Select would silently display a different person).
 */
export const localUserOptions = (
  users: readonly Pick<AdminUser, 'id' | 'email' | 'name'>[],
  savedId: string | null | undefined,
): { id: string; label: string }[] => {
  const options = users.map((user) => ({
    id: user.id,
    label: userOptionLabel(user),
  }));
  if (savedId && !options.some((option) => option.id === savedId)) {
    options.push({
      id: savedId,
      label: `Unknown user (${savedId.slice(0, 8)})`,
    });
  }
  return options;
};

/** A local-user change waiting for its confirmation: the id and its option label. */
export interface LocalUserChange {
  id: string | null;
  label: string;
}

/**
 * C-166: the local user is whose authority every hand-started session and the
 * plugin's requests on that machine carry, so changing it asks first.
 */
export function localUserChangeCopy(change: LocalUserChange): {
  title: string;
  consequence: string;
  verb: string;
} {
  return change.id === null
    ? {
        title: 'Remove the local user?',
        consequence:
          'Every request from a session started by hand on this machine, and from the agentdock plugin, is refused until a user is picked again.',
        verb: 'Remove',
      }
    : {
        title: `Act as ${change.label} on this machine?`,
        consequence: `Sessions started by hand on this machine, and the agentdock plugin's requests, act as ${change.label} from now on, never above operator.`,
        verb: 'Change user',
      };
}
