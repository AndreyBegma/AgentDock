'use client';

import {
  type ChangePasswordRequest,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PublicUser,
  type SessionInfo,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { Field, Input } from 'glass-ui/field';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { AuthGate } from '../../components/auth-gate';
import { PageNav } from '../../components/page-nav';
import { api, describeError } from '../../lib/api';

const formatTime = (iso: string) => new Date(iso).toLocaleString();

function PasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: ChangePasswordRequest = { currentPassword, newPassword };
      await api('/auth/me/password', { method: 'PATCH', body });
      setCurrentPassword('');
      setNewPassword('');
      toast.success('Password changed. Your other sessions were signed out.');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card pad="lg">
      <h2 className="mb-4 text-lg font-bold">Change password</h2>
      <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
        <Field label="Current password" htmlFor="current-password">
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </Field>
        <Field
          label="New password"
          htmlFor="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={error}
        >
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" variant="solid" disabled={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const load = useCallback(async () => {
    try {
      setSessions(await api<SessionInfo[]>('/auth/sessions'));
    } catch (err) {
      toast.error(describeError(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (session: SessionInfo) => {
    try {
      await api(`/auth/sessions/${session.id}`, { method: 'DELETE' });
      if (session.current) router.replace('/login');
      else await load();
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <Card pad="lg">
      <h2 className="mb-4 text-lg font-bold">Sessions</h2>
      <Table scroll>
        <TableHead>
          <TableRow>
            <TableCell head>Device</TableCell>
            <TableCell head>IP</TableCell>
            <TableCell head>Signed in</TableCell>
            <TableCell head>Last active</TableCell>
            <TableCell head>
              <span className="sr-only">Actions</span>
            </TableCell>
          </TableRow>
        </TableHead>
        <tbody>
          {sessions.map((session) => (
            <TableRow key={session.id}>
              <TableCell>
                <span className="mr-2">{session.userAgent ?? 'Unknown'}</span>
                {session.current ? <Badge tone="ok" label="current" /> : null}
              </TableCell>
              <TableCell>{session.ip ?? '—'}</TableCell>
              <TableCell>{formatTime(session.createdAt)}</TableCell>
              <TableCell>{formatTime(session.lastSeenAt)}</TableCell>
              <TableCell>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => revoke(session)}
                >
                  {session.current ? 'Sign out' : 'Revoke'}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function Profile({ user }: { user: PublicUser }) {
  return (
    <Card pad="lg">
      <h2 className="mb-4 text-lg font-bold">Profile</h2>
      <dl className="grid max-w-sm grid-cols-[6rem_1fr] gap-y-2 text-sm">
        <dt className="text-ink-3">Email</dt>
        <dd>{user.email}</dd>
        <dt className="text-ink-3">Name</dt>
        <dd>{user.name ?? '—'}</dd>
        <dt className="text-ink-3">Role</dt>
        <dd>{user.role}</dd>
      </dl>
    </Card>
  );
}

export default function AccountPage() {
  return (
    <AuthGate>
      {(user) => (
        <>
          <PageNav user={user} />
          <div className="flex flex-col gap-6">
            <Profile user={user} />
            <PasswordCard />
            <SessionsCard />
          </div>
        </>
      )}
    </AuthGate>
  );
}
