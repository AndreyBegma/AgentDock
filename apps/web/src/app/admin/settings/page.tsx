'use client';

import type { RegistrationState } from '@agentdock/shared';
import { Card } from '@andrewbehma/glass-ui/card';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { api, describeError } from '../../../lib/api';
import { useSection } from '../../../lib/section/use-section';

function RegistrationCard() {
  const section = useSection(
    () => api<RegistrationState>('/admin/settings/registration'),
    [],
  );

  const change = async (next: boolean) => {
    try {
      section.setData(
        await api<RegistrationState>('/admin/settings/registration', {
          method: 'PUT',
          body: { open: next } satisfies RegistrationState,
        }),
      );
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <Card pad="lg" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 id="registration-label" className="text-lg font-bold">
            Open registration
          </h2>
          <p className="text-sm text-ink-2">
            While open, anyone can register. Every new account still waits for
            your approval under Users › Pending.
          </p>
        </div>
        {section.data === undefined ? null : (
          <Toggle
            checked={section.data.open}
            onChange={change}
            labelledBy="registration-label"
          />
        )}
      </div>
      <AsyncSection
        section={section}
        unavailable={{
          title: 'The registration setting is not answering',
          stillWorks: 'It keeps its last saved value on the server.',
        }}
        isEmpty={() => false}
        empty={null}
        skeleton={<Skeleton className="h-6 w-40" />}
      >
        {() => null}
      </AsyncSection>
    </Card>
  );
}

export default function AdminSettingsPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="max-w-prose text-sm text-ink-2">
          Instance-wide settings. Server variables such as PUBLIC_URL and
          APP_ENCRYPTION_KEY are set in the API’s environment, not here.
        </p>
      </div>
      <RegistrationCard />
    </div>
  );
}
