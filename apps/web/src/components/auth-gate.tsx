'use client';

import type { PublicUser, Role } from '@agentdock/shared';
import { Skeleton } from 'glass-ui/skeleton';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';

interface AuthGateProps {
  /** Pages that need a specific role; others are sent to `/account`. */
  requiredRole?: Role;
  children: (user: PublicUser) => ReactNode;
}

/**
 * Page guard (spec D13): asks `GET /api/auth/me`, sends the visitor to
 * `/login` on 401, and non-admins away from admin pages.
 */
export function AuthGate({ requiredRole, children }: AuthGateProps) {
  const router = useRouter();
  const [user, setUser] = useState<PublicUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<PublicUser>('/auth/me')
      .then((me) => {
        if (cancelled) return;
        if (requiredRole && me.role !== requiredRole)
          router.replace('/account');
        else setUser(me);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          router.replace('/login');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requiredRole, router]);

  if (!user) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return <>{children(user)}</>;
}
