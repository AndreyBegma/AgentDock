'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Select } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { Tab, TabGroup, TabList, TabPanel } from '@andrewbehma/glass-ui/tabs';
import {
  type AdminUser,
  type RegistrationState,
  ROLES,
  type Role,
  USER_STATUSES,
  type UserStatus,
} from '@nautelle/shared';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ConfirmGate } from '../../../components/confirm/confirm-gate';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { DisabledReason } from '../../../components/prerequisites/disabled-reason';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import { useCurrentUser } from '../../../components/shell/user-context';
import { api, describeError } from '../../../lib/api';
import { Time } from '../../../lib/format/time';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';
import {
  defaultUsersTab,
  OWN_ROW_REASON,
  ROLE_HINT,
  ROLE_LABEL,
  roleChangeNeedsConfirm,
} from '../../../lib/users/format';
import { type Confirmation, confirmationCopy } from './confirmation';
import { RegistrationCard } from './registration-card';
import { TwoFactorPolicyCard } from './two-factor-policy-card';

const TABS: { status: UserStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'active', label: 'Active' },
  { status: 'disabled', label: 'Disabled' },
  { status: 'rejected', label: 'Rejected' },
];

/** What the empty tab means, and for Pending, why nobody may be arriving. */
function EmptyTab({
  tab,
  registrationOpen,
}: {
  tab: UserStatus;
  registrationOpen: boolean | undefined;
}) {
  if (tab === 'pending') {
    return registrationOpen === false ? (
      <EmptyState
        title="Registrations waiting for approval"
        description="Registration is closed, so nobody can sign up. Turn on Open registration above to let people register; each new account still waits here for you."
      />
    ) : (
      <EmptyState
        title="Registrations waiting for approval"
        description="People who register appear here. You approve each one and pick its role."
      />
    );
  }
  const description: Record<Exclude<UserStatus, 'pending'>, string> = {
    active: 'Approved accounts that can sign in.',
    disabled: 'Accounts you disabled. They cannot sign in until enabled.',
    rejected:
      'Registrations you rejected. Delete one to let it register again.',
  };
  return (
    <EmptyState title={`No ${tab} accounts`} description={description[tab]} />
  );
}

function UsersTable({ viewer }: { viewer: string }) {
  const section = useSection(
    () =>
      Promise.all(
        USER_STATUSES.map((status) =>
          api<AdminUser[]>(`/admin/users?status=${status}`),
        ),
      ).then((results) => results.flat()),
    [],
  );
  const registration = useSection(
    () => api<RegistrationState>('/admin/settings/registration'),
    [],
  );
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const showError = useErrorToast();
  const [roles, setRoles] = useState<Record<string, Role>>({});
  const [confirm, setConfirm] = useState<Confirmation>();
  const [confirming, setConfirming] = useState(false);
  // `?tab=` carries the tab; without it the page opens on Active, or on the
  // first tab that has accounts.
  const picked = USER_STATUSES.find((status) => status === params.get('tab'));
  const setTab = (next: UserStatus) => {
    const copy = new URLSearchParams(params.toString());
    copy.set('tab', next);
    router.replace(`${pathname}?${copy.toString()}`, { scroll: false });
  };
  const users = section.data ?? [];
  const counts = Object.fromEntries(
    USER_STATUSES.map((status) => [
      status,
      users.filter((user) => user.status === status).length,
    ]),
  ) as Record<UserStatus, number>;
  const tab = picked ?? defaultUsersTab(counts);

  const run = async (task: () => Promise<unknown>) => {
    try {
      await task();
    } catch (err) {
      showError(describeError(err));
    }
    section.retry();
  };

  const roleOf = (user: AdminUser): Role => roles[user.id] ?? user.role;

  const approve = (user: AdminUser, role: Role) =>
    run(() =>
      api(`/admin/users/${user.id}/approve`, {
        method: 'POST',
        body: { role },
      }),
    );

  const changeRole = (user: AdminUser, role: Role) => {
    setRoles((current) => ({ ...current, [user.id]: role }));
    return run(() =>
      api(`/admin/users/${user.id}`, { method: 'PATCH', body: { role } }),
    );
  };

  const pickRole = (user: AdminUser, role: Role) => {
    if (roleChangeNeedsConfirm(user.role, role)) {
      setConfirm({ user, action: 'role', role });
      return;
    }
    void changeRole(user, role);
  };

  const enable = (user: AdminUser) =>
    run(() =>
      api(`/admin/users/${user.id}`, {
        method: 'PATCH',
        body: { status: 'active' },
      }),
    );

  const execute = async () => {
    if (!confirm) return;
    setConfirming(true);
    try {
      if (confirm.action === 'role') {
        await changeRole(confirm.user, confirm.role);
        return;
      }
      if (confirm.action === 'approve') {
        await approve(confirm.user, confirm.role);
        return;
      }
      const { user, action } = confirm;
      await run(() => {
        if (action === 'reject') {
          return api(`/admin/users/${user.id}/reject`, { method: 'POST' });
        }
        if (action === 'reset_two_factor') {
          return api(`/admin/users/${user.id}/two-factor`, {
            method: 'DELETE',
          });
        }
        if (action === 'disable') {
          return api(`/admin/users/${user.id}`, {
            method: 'PATCH',
            body: { status: 'disabled' },
          });
        }
        return api(`/admin/users/${user.id}`, { method: 'DELETE' });
      });
    } finally {
      setConfirming(false);
      setConfirm(undefined);
    }
  };

  const roleSelect = (user: AdminUser, onChange: (role: Role) => void) => (
    <div className="flex flex-col gap-1">
      <Select
        aria-label={`Role for ${user.email}`}
        value={roleOf(user)}
        onChange={(e) => onChange(e.target.value as Role)}
        className="w-32"
      >
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABEL[role]}
          </option>
        ))}
      </Select>
      <span className="max-w-56 text-xs text-ink-3">
        {ROLE_HINT[roleOf(user)]}
      </span>
    </div>
  );

  const renderTable = (list: AdminUser[]) => (
    <ScrollX className="relative">
      <Table>
        <TableHead>
          <TableRow>
            <TableCell head>Email</TableCell>
            <TableCell head>Name</TableCell>
            <TableCell head>Role</TableCell>
            <TableCell head>Registered</TableCell>
            <TableCell head>
              <span className="sr-only">Actions</span>
            </TableCell>
          </TableRow>
        </TableHead>
        <tbody>
          {list
            .filter((user) => user.status === tab)
            .map((user) => {
              const own = user.id === viewer;
              return (
                <TableRow key={user.id}>
                  <TableCell>
                    {user.email}
                    {own ? (
                      <Badge className="ml-2" tone="neutral" label="you" />
                    ) : null}
                    {user.twoFactorEnabled ? (
                      <Badge className="ml-2" tone="ok" label="2FA" />
                    ) : null}
                  </TableCell>
                  <TableCell>{user.name ?? '—'}</TableCell>
                  <TableCell>
                    {user.status === 'pending'
                      ? roleSelect(user, (role) =>
                          setRoles((c) => ({ ...c, [user.id]: role })),
                        )
                      : user.status === 'active'
                        ? roleSelect(user, (role) => pickRole(user, role))
                        : ROLE_LABEL[user.role]}
                  </TableCell>
                  <TableCell>
                    <Time value={user.createdAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {user.status === 'pending' ? (
                        <>
                          <Button
                            variant="glass"
                            size="sm"
                            onClick={() =>
                              setConfirm({
                                user,
                                action: 'approve',
                                role: roleOf(user),
                              })
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() =>
                              setConfirm({ user, action: 'reject' })
                            }
                          >
                            Reject
                          </Button>
                        </>
                      ) : null}
                      {own ? (
                        <DisabledReason>{OWN_ROW_REASON}</DisabledReason>
                      ) : null}
                      {user.twoFactorEnabled && !own ? (
                        <Button
                          variant="glass"
                          size="sm"
                          onClick={() =>
                            setConfirm({ user, action: 'reset_two_factor' })
                          }
                        >
                          Reset 2FA
                        </Button>
                      ) : null}
                      {user.status === 'active' && !own ? (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() =>
                            setConfirm({ user, action: 'disable' })
                          }
                        >
                          Disable
                        </Button>
                      ) : null}
                      {user.status === 'disabled' ? (
                        <Button
                          variant="glass"
                          size="sm"
                          onClick={() => enable(user)}
                        >
                          Enable
                        </Button>
                      ) : null}
                      {(user.status === 'active' ||
                        user.status === 'disabled' ||
                        user.status === 'rejected') &&
                      !own ? (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setConfirm({ user, action: 'delete' })}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
        </tbody>
      </Table>
    </ScrollX>
  );

  return (
    <>
      <div className="mb-4 flex flex-col gap-4">
        <RegistrationCard section={registration} />
        <TwoFactorPolicyCard />
      </div>

      <TabGroup
        value={tab}
        onValueChange={(next) => setTab(next as UserStatus)}
      >
        <ScrollX className="mb-4 max-w-lg">
          <TabList aria-label="Account status" className="min-w-max">
            {TABS.map(({ status, label }) => (
              <Tab key={status} value={status} className="whitespace-nowrap">
                <span className="inline-flex items-center gap-2">
                  {label}
                  {section.data ? (
                    <Badge
                      tone={
                        status === 'pending' && counts.pending > 0
                          ? 'warn'
                          : 'neutral'
                      }
                      count={counts[status]}
                    />
                  ) : null}
                </span>
              </Tab>
            ))}
          </TabList>
        </ScrollX>

        <TabPanel value={tab}>
          <AsyncSection
            section={section}
            unavailable={{
              title: 'Accounts are not answering',
              stillWorks: 'People who are signed in stay signed in.',
            }}
            isEmpty={(list) => !list.some((user) => user.status === tab)}
            skeleton={<Skeleton className="h-48 w-full" />}
            empty={
              <EmptyTab tab={tab} registrationOpen={registration.data?.open} />
            }
          >
            {renderTable}
          </AsyncSection>
        </TabPanel>
      </TabGroup>

      <ConfirmGate
        pending={confirm}
        copy={confirmationCopy}
        busy={confirming}
        onConfirm={() => void execute()}
        onCancel={() => setConfirm(undefined)}
      />
    </>
  );
}

export default function AdminUsersPage() {
  const viewer = useCurrentUser().id;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Users"
        description="Approve registrations, pick each person’s role, and disable or delete accounts. Operators and viewers see only the projects they are added to, under each project’s Settings › Members."
      />
      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <UsersTable viewer={viewer} />
      </Suspense>
    </div>
  );
}
