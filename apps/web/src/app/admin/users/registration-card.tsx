'use client';

import type { RegistrationState } from '@agentdock/shared';
import { Card } from '@andrewbehma/glass-ui/card';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { api, describeError } from '../../../lib/api';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import type { Section } from '../../../lib/section/use-section';

/** The instance-wide switch that decides whether new accounts can arrive. */
export function RegistrationCard({
  section,
}: {
  section: Section<RegistrationState>;
}) {
  const showError = useErrorToast();
  const change = async (next: boolean) => {
    try {
      section.setData(
        await api<RegistrationState>('/admin/settings/registration', {
          method: 'PUT',
          body: { open: next } satisfies RegistrationState,
        }),
      );
    } catch (err) {
      showError(describeError(err));
    }
  };

  return (
    <Card pad="md">
      <SectionHeader
        headingId="registration-label"
        title="Open registration"
        description="While open, anyone can register. Every new account still waits for your approval under Pending."
        actions={
          section.data !== undefined ? (
            <Toggle
              checked={section.data.open}
              onChange={change}
              labelledBy="registration-label"
            />
          ) : section.error !== null && !section.loading ? (
            <span className="text-sm text-ink-2" role="status">
              Not answering — it keeps its last saved value on the server.
            </span>
          ) : (
            <Skeleton className="h-6 w-11" />
          )
        }
      />
    </Card>
  );
}
