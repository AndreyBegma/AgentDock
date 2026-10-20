'use client';

import { APP_VERSION, CHANGELOG } from '@agentdock/shared';
import { useEffect } from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { useWhatsNew } from '../../../components/shell/whats-new-context';
import { ChangelogList } from '../../../components/whats-new/changelog-list';
import { versionLabel } from '../../../lib/whats-new/whats-new';

/** C-294: every release, newest first; opening it clears the unread dot. */
export default function WhatsNewPage() {
  const { markSeen } = useWhatsNew();
  useEffect(() => markSeen(), [markSeen]);

  return (
    <>
      <PageHeader
        title="What’s new"
        description={`Nautelle ${versionLabel(APP_VERSION)} — what each release brought.`}
      />
      <ChangelogList entries={CHANGELOG} />
    </>
  );
}
