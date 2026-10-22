'use client';

import { Section } from '@andrewbehma/glass-ui/section';
import { toast } from '@andrewbehma/glass-ui/toast';
import type { TechniqueMode } from '@nautelle/shared';
import Link from 'next/link';
import { useCallback } from 'react';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { useSection } from '../../lib/section/use-section';
import {
  fetchTokenEconomyReport,
  setTechniqueMode,
} from '../../lib/token-saver/actions';
import { describeTokenSaverError } from '../../lib/token-saver/format';
import { AsyncSection } from '../prerequisites/async-section';
import { TechniquesReport } from './techniques-report';

const MODE_SAVED: Record<TechniqueMode, string> = {
  on: 'Enabled for every new card.',
  off: 'Stopped for new cards.',
  ab: 'Back to the A/B test for new cards.',
};

/**
 * #746 "UI": the Token saver page's top section — every saving technique,
 * arm A against arm B over the page's range. It loads and fails on its own;
 * the rest of the page keeps working.
 */
export function TechniquesSection({
  projectId,
  range,
  isAdmin,
}: {
  projectId: string;
  range: { from: string; to: string };
  isAdmin: boolean;
}) {
  const section = useSection(
    () => fetchTokenEconomyReport(projectId, range),
    [projectId, range.from, range.to],
  );
  const { retry } = section;
  const showError = useErrorToast();

  const onSetMode = useCallback(
    async (technique: string, mode: TechniqueMode) => {
      try {
        await setTechniqueMode(projectId, technique, { mode });
      } catch (err) {
        showError(describeTokenSaverError(err));
        throw err;
      }
      toast.success(MODE_SAVED[mode]);
      retry();
    },
    [projectId, retry, showError],
  );

  const settingsHref = `/projects/${encodeURIComponent(projectId)}/settings?tab=token-saver`;
  const share = section.data?.bSharePercent;

  return (
    <Section
      title="Techniques"
      description={
        <>
          Each saving technique is tested on a share of new cards (arm B)
          against the rest (arm A): what a merged card costs, and four signals
          that the result did not suffer. A card keeps its arm for all its
          rounds. Small figures under a value are its 95 % interval.
          {share !== undefined ? (
            <>
              {' '}
              Arm B gets {share}% of new cards (
              <Link
                href={settingsHref}
                className="text-accent-ink underline underline-offset-2"
              >
                change
              </Link>
              ).
            </>
          ) : null}
        </>
      }
      surface="none"
      pad="none"
    >
      <AsyncSection
        section={section}
        unavailable={{
          title: 'The technique report is not answering',
          stillWorks:
            'The cost per round and the filter savings below still load.',
        }}
        empty={null}
      >
        {(report) => (
          <TechniquesReport
            report={report}
            isAdmin={isAdmin}
            onSetMode={onSetMode}
          />
        )}
      </AsyncSection>
    </Section>
  );
}
