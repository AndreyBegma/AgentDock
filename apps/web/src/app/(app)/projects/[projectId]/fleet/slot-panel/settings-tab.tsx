'use client';

import type { OrchestratorSettingsView, SlotDetail } from '@agentdock/shared';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import Link from 'next/link';
import type { Section } from '../../../../../../lib/section/use-section';

/**
 * How the slot runs, read-only: the orchestrator chose the runtime and the
 * model when it dispatched the slot (ADR-0005), and the runtime profile is
 * the project's. Both change in the project's settings, not here.
 */
export function SettingsTab({
  projectId,
  slot,
  settings,
}: {
  projectId: string;
  slot: SlotDetail;
  settings: Section<OrchestratorSettingsView>;
}) {
  const profile = settings.data?.effectiveProfile;
  return (
    <div className="flex flex-col gap-4">
      <KeyValueList
        items={[
          { key: 'runtime', label: 'Runtime', value: slot.runtime },
          { key: 'model', label: 'Model', value: slot.model ?? 'unknown' },
          {
            key: 'profile',
            label: 'Runtime profile',
            value: profile
              ? `${profile.label} (${profile.key})`
              : settings.data
                ? 'none set'
                : settings.error !== null
                  ? 'could not be loaded'
                  : '…',
          },
        ]}
      />
      <p className="text-xs text-ink-3">
        The orchestrator picks a slot’s runtime and model when it dispatches it.
        The runtime profile is the project’s.{' '}
        <Link
          href={`/projects/${projectId}/settings`}
          className="text-accent-ink underline underline-offset-2"
        >
          Open project settings
        </Link>
      </p>
    </div>
  );
}
