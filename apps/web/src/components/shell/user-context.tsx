'use client';

import type { PublicUser } from '@agentdock/shared';
import { createContext, useContext } from 'react';

const UserContext = createContext<PublicUser | null>(null);

export const UserProvider = UserContext.Provider;

/** The signed-in user the shell layout resolved on the server. */
export function useCurrentUser(): PublicUser {
  const user = useContext(UserContext);
  if (!user) throw new Error('useCurrentUser needs the application shell');
  return user;
}
