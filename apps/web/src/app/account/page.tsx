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
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Monitor, Smartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '../../components/page-header/page-header';
import { AsyncSection } from '../../components/prerequisites/async-section';
import { useCurrentUser } from '../../components/shell/user-context';
import { api, describeError, describeErrorHint } from '../../lib/api';
import { Time } from '../../lib/format/time';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { useSection } from '../../lib/section/use-section';
import { parseUserAgent } from './user-agent';

const ROLE_LABEL: Record<PublicUser['role'], string> = {
  admin: 'Administrator',
  operator: 'Operator',
  viewer: 'Viewer',
};

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
      <SectionHeader className="mb-4" title="Change password" />
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
  const [revoking, setRevoking] = useState<SessionInfo>();
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api(`/auth/sessions/${revoking.id}`, { method: 'DELETE' });
      if (revoking.current) router.replace('/login');
      else devices.retry();
      setRevoking(undefined);
    } catch (err) {
      showError(describeErrorHint(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card pad="lg">
      <SectionHeader
        className="mb-4"
        title="Signed-in devices"
        description="Browsers and devices that are signed in to your account. Revoke one you do not recognise."
      />
      <AsyncSection
        section={devices}
        unavailable={{
          title: 'Your devices could not be loaded',
          stillWorks: 'The rest of your account is unaffected.',
        }}
        empty={
          <EmptyState
            title="No signed-in devices"
            description="Devices appear here when they sign in to your account."
          />
        }
        isEmpty={(list) => list.length === 0}
        skeleton={<Skeleton className="h-24 w-full" />}
      >
        {(sessions) => (
          <SessionList sessions={sessions} onRevoke={setRevoking} />
        )}
      </AsyncSection>
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        title={
          revoking?.current ? 'Sign out of this device?' : 'Revoke this device?'
        }
        consequence={
          revoking?.current
            ? 'You are signed out here and taken to the sign-in page.'
            : 'The device is signed out at once and has to sign in again.'
        }
        verb={revoking?.current ? 'Sign out' : 'Revoke'}
        busy={busy}
        onConfirm={() => void revoke()}
      />
    </Card>
  );
}

function SessionList({
  sessions,
  onRevoke,
}: {
  sessions: SessionInfo[];
  onRevoke: (session: SessionInfo) => void;
}) {
  return (
    <ul className="divide-y divide-line">
      {sessions.map((session) => {
        const device = parseUserAgent(session.userAgent);
        const Icon = device.mobile ? Smartphone : Monitor;
        return (
          <li
            key={session.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
          >
            <Icon
              size={18}
              className="shrink-0 text-ink-3"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <span title={session.userAgent ?? undefined}>
                  {device.label}
                </span>
                {session.current ? (
                  <Badge tone="ok" label="This device" />
                ) : null}
              </div>
              <div className="text-xs text-ink-3">
                {session.ip ? (
                  <span className="font-mono">{session.ip}</span>
                ) : (
                  'IP unknown'
                )}{' '}
                · signed in <Time value={session.createdAt} /> · active{' '}
                <Time value={session.lastSeenAt} />
              </div>
            </div>
            <Button
              variant={session.current ? 'glass' : 'danger'}
              size="sm"
              onClick={() => onRevoke(session)}
            >
              {session.current ? 'Sign out' : 'Revoke'}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function Profile({ user }: { user: PublicUser }) {
  return (
    <Card pad="lg">
      <SectionHeader className="mb-4" title="Profile" />
      <dl className="grid max-w-sm grid-cols-[6rem_1fr] gap-y-2 text-sm">
        <dt className="text-ink-3">Email</dt>
        <dd>{user.email}</dd>
        <dt className="text-ink-3">Name</dt>
        <dd>{user.name ?? '—'}</dd>
        <dt className="text-ink-3">Role</dt>
        <dd>{ROLE_LABEL[user.role] ?? user.role}</dd>
      </dl>
    </Card>
  );
}

export default function AccountPage() {
  const user = useCurrentUser();
  return (
    <div>
      <PageHeader
        title="Account"
        description="Your profile, password and the devices signed in as you."
      />
      <div className="flex flex-col gap-6">
        <Profile user={user} />
        <PasswordCard />
        <SessionsCard />
      </div>
    </div>
  );
}
