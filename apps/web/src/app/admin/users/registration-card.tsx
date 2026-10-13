'use client';

import type { RegistrationState } from '@agentdock/shared';
import { Card } from '@andrewbehma/glass-ui/card';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { api, describeError } from '../../../lib/api';
import type { Section } from '../../../lib/section/use-section';

/** The instance-wide switch that decides whether new accounts can arrive. */
export function RegistrationCard({
  section,
}: {
  section: Section<RegistrationState>;
}) {
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
    <Card pad="md" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 id="registration-label" className="text-base font-semibold">
            Open registration
          </h2>
          <p className="text-sm text-ink-2">
            While open, anyone can register. Every new account still waits for
            your approval under Pending.
          </p>
        </div>
        {section.data !== undefined ? (
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
        )}
      </div>
    </Card>
  );
}
