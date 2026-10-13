'use client';

import {
  type ChangePasswordRequest,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PublicUser,
  type SessionInfo,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useCurrentUser } from '../../components/shell/user-context';
import { api, describeError, describeErrorHint } from '../../lib/api';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { useSection } from '../../lib/section/use-section';

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
  const showError = useErrorToast();
  const devices = useSection(() => api<SessionInfo[]>('/auth/sessions'), []);
  const sessions = devices.data ?? [];

  const revoke = async (session: SessionInfo) => {
    try {
      await api(`/auth/sessions/${session.id}`, { method: 'DELETE' });
      if (session.current) router.replace('/login');
      else devices.retry();
    } catch (err) {
      showError(describeErrorHint(err));
    }
  };

  return (
    <Card pad="lg">
      <h2 className="mb-1 text-lg font-bold">Signed-in devices</h2>
      <p className="mb-4 text-sm text-ink-2">
        Browsers and devices that are signed in to your account. Revoke one you
        do not recognise.
      </p>
      {devices.data === undefined ? (
        devices.error !== null && !devices.loading ? (
          <SectionUnavailable
            title="Your devices could not be loaded"
            stillWorks={`${describeError(devices.error)} The rest of your account is unaffected.`}
            action={
              <Button variant="glass" size="sm" onClick={devices.retry}>
                Try again
              </Button>
            }
          />
        ) : (
          <Skeleton className="h-24 w-full" />
        )
      ) : (
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
      )}
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
  const user = useCurrentUser();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Account</h1>
        <p className="text-sm text-ink-2">
          Your profile, password and the devices signed in as you.
        </p>
      </div>
      <Profile user={user} />
      <PasswordCard />
      <SessionsCard />
    </div>
  );
}
