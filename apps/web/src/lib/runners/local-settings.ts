import type { AdminUser } from '@agentdock/shared';

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
