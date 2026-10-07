'use client';

import {
  type AdminUser,
  ROLES,
  type Role,
  USER_STATUSES,
  type UserStatus,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Select } from 'glass-ui/field';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { Tabs, TabsItem } from 'glass-ui/tabs';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { AuthGate } from '../../../components/auth-gate';
import { PageNav } from '../../../components/page-nav';
import { api, describeError } from '../../../lib/api';

const TABS: { status: UserStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'active', label: 'Active' },
  { status: 'disabled', label: 'Disabled' },
  { status: 'rejected', label: 'Rejected' },
];

type Confirmation = {
  user: AdminUser;
  action: 'reject' | 'disable' | 'delete';
};

const CONFIRM_COPY: Record<
  Confirmation['action'],
  { title: string; verb: string; text: (u: AdminUser) => string }
> = {
  reject: {
    title: 'Reject registration',
    verb: 'Reject',
    text: (u) =>
      `${u.email} will not be able to sign in or register again until you delete the account.`,
  },
  disable: {
    title: 'Disable account',
    verb: 'Disable',
    text: (u) => `${u.email} will be signed out everywhere immediately.`,
  },
  delete: {
    title: 'Delete account',
    verb: 'Delete',
    text: (u) => `${u.email} and all of their sessions will be removed.`,
  },
};

function UsersTable({ viewer }: { viewer: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [tab, setTab] = useState<UserStatus>('pending');
  const [roles, setRoles] = useState<Record<string, Role>>({});
  const [confirm, setConfirm] = useState<Confirmation>();

  const load = useCallback(async () => {
    try {
      const results = await Promise.all(
        USER_STATUSES.map((status) =>
          api<AdminUser[]>(`/admin/users?status=${status}`),
        ),
      );
      setUsers(results.flat());
    } catch (err) {
      toast.error(describeError(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (task: () => Promise<unknown>) => {
    try {
      await task();
    } catch (err) {
      toast.error(describeError(err));
    }
    await load();
  };

  const roleOf = (user: AdminUser): Role => roles[user.id] ?? user.role;

  const approve = (user: AdminUser) =>
    run(() =>
      api(`/admin/users/${user.id}/approve`, {
        method: 'POST',
        body: { role: roleOf(user) },
      }),
    );

  const changeRole = (user: AdminUser, role: Role) => {
    setRoles((current) => ({ ...current, [user.id]: role }));
    return run(() =>
      api(`/admin/users/${user.id}`, { method: 'PATCH', body: { role } }),
    );
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
    const { user, action } = confirm;
    setConfirm(undefined);
    await run(() => {
      if (action === 'reject') {
        return api(`/admin/users/${user.id}/reject`, { method: 'POST' });
      }
      if (action === 'disable') {
        return api(`/admin/users/${user.id}`, {
          method: 'PATCH',
          body: { status: 'disabled' },
        });
      }
      return api(`/admin/users/${user.id}`, { method: 'DELETE' });
    });
  };

  const visible = users.filter((user) => user.status === tab);
  const count = (status: UserStatus) =>
    users.filter((user) => user.status === status).length;

  const roleSelect = (user: AdminUser, onChange: (role: Role) => void) => (
    <Select
      aria-label={`Role for ${user.email}`}
      value={roleOf(user)}
      onChange={(e) => onChange(e.target.value as Role)}
      className="w-32"
    >
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </Select>
  );

  return (
    <>
      <Tabs aria-label="Account status" className="mb-4 max-w-lg">
        {TABS.map(({ status, label }) => (
          <TabsItem key={status} current={tab === status} layoutId="users-tab">
            <button
              type="button"
              onClick={() => setTab(status)}
              aria-pressed={tab === status}
              className="relative flex w-full items-center justify-center gap-2 px-3 py-2 text-sm font-medium"
            >
              {label}
              {status === 'pending' && count('pending') > 0 ? (
                <Badge tone="warn" count={count('pending')} />
              ) : null}
            </button>
          </TabsItem>
        ))}
      </Tabs>

      {visible.length === 0 ? (
        <EmptyState
          title={`No ${tab} accounts`}
          description={
            tab === 'pending'
              ? 'New registrations waiting for approval appear here.'
              : undefined
          }
        />
      ) : (
        <Table scroll>
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
            {visible.map((user) => (
              <TableRow key={user.id}>
                <TableCell>
                  {user.email}
                  {user.id === viewer ? (
                    <Badge className="ml-2" tone="neutral" label="you" />
                  ) : null}
                </TableCell>
                <TableCell>{user.name ?? '—'}</TableCell>
                <TableCell>
                  {user.status === 'pending'
                    ? roleSelect(user, (role) =>
                        setRoles((c) => ({ ...c, [user.id]: role })),
                      )
                    : user.status === 'active'
                      ? roleSelect(user, (role) => changeRole(user, role))
                      : user.role}
                </TableCell>
                <TableCell>
                  {new Date(user.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    {user.status === 'pending' ? (
                      <>
                        <Button
                          variant="solid"
                          size="sm"
                          onClick={() => approve(user)}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setConfirm({ user, action: 'reject' })}
                        >
                          Reject
                        </Button>
                      </>
                    ) : null}
                    {user.status === 'active' ? (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => setConfirm({ user, action: 'disable' })}
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
                    {user.status === 'active' ||
                    user.status === 'disabled' ||
                    user.status === 'rejected' ? (
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
            ))}
          </tbody>
        </Table>
      )}

      <DialogRoot
        open={confirm !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirm(undefined);
        }}
      >
        {confirm ? (
          <DialogContent
            title={CONFIRM_COPY[confirm.action].title}
            description={CONFIRM_COPY[confirm.action].text(confirm.user)}
            footer={
              <>
                <Button variant="ghost" onClick={() => setConfirm(undefined)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={execute}>
                  {CONFIRM_COPY[confirm.action].verb}
                </Button>
              </>
            }
          >
            {null}
          </DialogContent>
        ) : null}
      </DialogRoot>
    </>
  );
}

export default function AdminUsersPage() {
  return (
    <AuthGate requiredRole="admin">
      {(user) => (
        <>
          <PageNav user={user} />
          <UsersTable viewer={user.id} />
        </>
      )}
    </AuthGate>
  );
}
