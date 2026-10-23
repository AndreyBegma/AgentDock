'use client';

import { Card } from '@andrewbehma/glass-ui/card';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import type { TwoFactorPolicy } from '@nautelle/shared';
import { api, describeError } from '../../../lib/api';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';

/** C-189: the instance-wide switch that requires two-factor sign-in of admins. */
export function TwoFactorPolicyCard() {
  const section = useSection(
    () => api<TwoFactorPolicy>('/admin/settings/two-factor'),
    [],
  );
  const showError = useErrorToast();
  const change = async (next: boolean) => {
    try {
      section.setData(
        await api<TwoFactorPolicy>('/admin/settings/two-factor', {
          method: 'PUT',
          body: { requiredForAdmins: next } satisfies TwoFactorPolicy,
        }),
      );
    } catch (err) {
      showError(describeError(err));
    }
  };

  return (
    <Card pad="md">
      <SectionHeader
        headingId="two-factor-policy-label"
        title="Require two-factor sign-in for administrators"
        description="While on, an administrator without it can only reach Account until they set it up. Set it up for yourself first."
        actions={
          section.data !== undefined ? (
            <Toggle
              checked={section.data.requiredForAdmins}
              onChange={change}
              labelledBy="two-factor-policy-label"
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
