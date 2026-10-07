'use client';

import type { RegistrationState } from '@agentdock/shared';
import { Card } from 'glass-ui/card';
import { toast } from 'glass-ui/toast';
import { Toggle } from 'glass-ui/toggle';
import { useEffect, useState } from 'react';
import { AuthGate } from '../../../components/auth-gate';
import { PageNav } from '../../../components/page-nav';
import { api, describeError } from '../../../lib/api';

function RegistrationCard() {
  const [open, setOpen] = useState<boolean>();

  useEffect(() => {
    api<RegistrationState>('/admin/settings/registration')
      .then((state) => setOpen(state.open))
      .catch((err) => toast.error(describeError(err)));
  }, []);

  const change = async (next: boolean) => {
    try {
      const state = await api<RegistrationState>(
        '/admin/settings/registration',
        { method: 'PUT', body: { open: next } satisfies RegistrationState },
      );
      setOpen(state.open);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <Card pad="lg" className="flex items-center justify-between gap-4">
      <div>
        <h2 id="registration-label" className="text-lg font-bold">
          Open registration
        </h2>
        <p className="text-sm text-ink-2">
          While open, anyone can register. Every new account still waits for
          your approval.
        </p>
      </div>
      {open === undefined ? null : (
        <Toggle
          checked={open}
          onChange={change}
          labelledBy="registration-label"
        />
      )}
    </Card>
  );
}

export default function AdminSettingsPage() {
  return (
    <AuthGate requiredRole="admin">
      {(user) => (
        <>
          <PageNav user={user} />
          <RegistrationCard />
        </>
      )}
    </AuthGate>
  );
}
