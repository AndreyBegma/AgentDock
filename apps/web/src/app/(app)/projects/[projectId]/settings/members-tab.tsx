'use client';

import {
  type AddProjectMemberRequest,
  type AdminUser,
  type ProjectMemberView,
  ROLES,
  type Role,
  type UpdateProjectMemberRequest,
} from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Select } from 'glass-ui/field';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import { describeProjectError } from '../../../../../lib/projects/format';

/** "" is no override. */
const NO_OVERRIDE = '';

function AddMemberDialog({
  projectId,
  members,
  open,
  onClose,
  onAdded,
}: {
  projectId: string;
  members: ProjectMemberView[];
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userId, setUserId] = useState('');
  const [override, setOverride] = useState(NO_OVERRIDE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUserId('');
    setOverride(NO_OVERRIDE);
    api<AdminUser[]>('/admin/users?status=active')
      .then(setUsers)
      .catch((err) => toast.error(describeProjectError(err)));
  }, [open]);

  const candidates = users.filter(
    (user) =>
      user.role !== 'admin' &&
      !members.some((member) => member.userId === user.id),
  );

  const submit = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      const body: AddProjectMemberRequest = {
        userId,
        roleOverride: override === NO_OVERRIDE ? null : (override as Role),
      };
      await api(`/projects/${projectId}/members`, { method: 'POST', body });
      onAdded();
    } catch (err) {
      toast.error(describeProjectError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title="Add member"
        description="Administrators see every project and need no membership. An override can only lower a member's role."
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="solid" onClick={submit} disabled={busy || !userId}>
              Add
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="User" htmlFor="member-user" required>
            <Select
              id="member-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">Choose a user</option>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.email} ({user.role})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role override" htmlFor="member-override">
            <Select
              id="member-override"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
            >
              <option value={NO_OVERRIDE}>None (use their global role)</option>
              {ROLES.filter((role) => role !== 'admin').map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

export function MembersTab({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const [members, setMembers] = useState<ProjectMemberView[]>();
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers(
        await api<ProjectMemberView[]>(`/projects/${projectId}/members`),
      );
    } catch (err) {
      toast.error(describeProjectError(err));
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (task: () => Promise<unknown>) => {
    try {
      await task();
    } catch (err) {
      toast.error(describeProjectError(err));
    }
    await load();
  };

  const setOverride = (member: ProjectMemberView, value: string) => {
    const body: UpdateProjectMemberRequest = {
      roleOverride: value === NO_OVERRIDE ? null : (value as Role),
    };
    return run(() =>
      api(`/projects/${projectId}/members/${member.userId}`, {
        method: 'PATCH',
        body,
      }),
    );
  };

  const remove = (member: ProjectMemberView) =>
    run(() =>
      api(`/projects/${projectId}/members/${member.userId}`, {
        method: 'DELETE',
      }),
    );

  return (
    <Card pad="lg" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Members</h2>
        {isAdmin ? (
          <Button variant="solid" size="sm" onClick={() => setAdding(true)}>
            Add member
          </Button>
        ) : null}
      </div>

      {members && members.length === 0 ? (
        <EmptyState
          title="No members"
          description="Administrators see every project. Operators and viewers see only projects they are members of."
        />
      ) : (
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>User</TableCell>
              <TableCell head>Global role</TableCell>
              <TableCell head>Override</TableCell>
              <TableCell head>Effective role</TableCell>
              {isAdmin ? (
                <TableCell head>
                  <span className="sr-only">Actions</span>
                </TableCell>
              ) : null}
            </TableRow>
          </TableHead>
          <tbody>
            {(members ?? []).map((member) => (
              <TableRow key={member.userId}>
                <TableCell>
                  {member.name ? `${member.name} · ` : ''}
                  {member.email}
                </TableCell>
                <TableCell>{member.globalRole}</TableCell>
                <TableCell>
                  {isAdmin ? (
                    <Select
                      aria-label={`Role override for ${member.email}`}
                      value={member.roleOverride ?? NO_OVERRIDE}
                      onChange={(e) => setOverride(member, e.target.value)}
                      className="w-32"
                    >
                      <option value={NO_OVERRIDE}>none</option>
                      {ROLES.filter((role) => role !== 'admin').map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    (member.roleOverride ?? '—')
                  )}
                </TableCell>
                <TableCell>{member.effectiveRole}</TableCell>
                {isAdmin ? (
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${member.email}`}
                        onClick={() => remove(member)}
                      >
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}

      {isAdmin ? (
        <AddMemberDialog
          projectId={projectId}
          members={members ?? []}
          open={adding}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}
    </Card>
  );
}
