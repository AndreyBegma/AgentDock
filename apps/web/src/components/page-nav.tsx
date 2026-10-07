'use client';

import type { PublicUser } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button, buttonClassName } from 'glass-ui/button';
import { toast } from 'glass-ui/toast';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, describeError } from '../lib/api';

/** Plain page header until the application shell (M1.8) arrives. */
export function PageNav({ user }: { user: PublicUser }) {
  const router = useRouter();

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
      router.replace('/login');
    } catch (error) {
      toast.error(describeError(error));
    }
  };

  return (
    <header className="glass mb-8 flex flex-wrap items-center gap-2 rounded-surface p-3">
      <span className="mr-2 font-bold">AgentDock</span>
      <Link href="/account" className={buttonClassName({ variant: 'ghost' })}>
        Account
      </Link>
      {user.role === 'admin' ? (
        <>
          <Link
            href="/admin/users"
            className={buttonClassName({ variant: 'ghost' })}
          >
            Users
          </Link>
          <Link
            href="/admin/runners"
            className={buttonClassName({ variant: 'ghost' })}
          >
            Runners
          </Link>
          <Link
            href="/admin/settings"
            className={buttonClassName({ variant: 'ghost' })}
          >
            Settings
          </Link>
        </>
      ) : null}
      <span className="ml-auto text-sm text-ink-2">{user.email}</span>
      <Badge tone="neutral" label={user.role} />
      <Button variant="glass" onClick={logout}>
        Sign out
      </Button>
    </header>
  );
}
