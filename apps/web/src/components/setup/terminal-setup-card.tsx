'use client';

import type {
  IgnoreTerminalSetupProfileRequest,
  SetupStep,
  TerminalSetupItem,
  TerminalSetupView,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import Link from 'next/link';
import { useState } from 'react';
import { api, describeError } from '../../lib/api';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { useSection } from '../../lib/section/use-section';
import {
  ASK_AN_ADMIN,
  BLOCKED_LABEL,
  IGNORED_PROFILES_TITLE,
  OTHER_PROFILES_DESCRIPTION,
  OTHER_PROFILES_TITLE,
  SETUP_STATE_LABEL,
  SETUP_STATE_TONE,
  setupItemTitle,
  stepNeedsAdmin,
  stepsLabel,
} from '../../lib/setup/format';

function Step({ step, isAdmin }: { step: SetupStep; isAdmin: boolean }) {
  switch (step.kind) {
    case 'command':
      return (
        <div className="flex flex-col gap-1">
          {step.label ? (
            <span className="text-xs text-ink-3">{step.label}</span>
          ) : null}
          <CodeBlock code={step.code} language="sh" />
        </div>
      );
    case 'link':
      if (stepNeedsAdmin(step) && !isAdmin) {
        return (
          <p className="text-sm text-ink-2">
            {step.label} — {ASK_AN_ADMIN}
          </p>
        );
      }
      return (
        <Link
          href={step.href}
          className="text-sm text-ink-2 underline hover:text-ink"
        >
          {step.label}
        </Link>
      );
    case 'note':
      return <p className="text-sm text-ink-2">{step.text}</p>;
  }
}

/** #719: hide a profile from AgentDock on the runner, or show it again. */
type SetIgnored = (profileKey: string, ignored: boolean) => void;

function Item({
  item,
  isAdmin,
  onIgnore,
}: {
  item: TerminalSetupItem;
  isAdmin: boolean;
  onIgnore?: SetIgnored;
}) {
  const open = item.state !== 'done';
  const profileKey = item.id === 'plugin' ? item.profileKey : undefined;
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={SETUP_STATE_TONE[item.state]}
          size="sm"
          label={SETUP_STATE_LABEL[item.state]}
        />
        <span className="min-w-0 break-words text-sm font-medium">
          {setupItemTitle(item)}
        </span>
        {item.optional ? (
          <span className="text-xs text-ink-3">optional</span>
        ) : null}
        {item.blockedBy ? (
          <span className="text-xs text-warn">{BLOCKED_LABEL[item.id]}</span>
        ) : null}
        {onIgnore && profileKey ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => onIgnore(profileKey, true)}
          >
            Ignore
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-2 pl-0 sm:pl-4">
          {item.steps.map((step, index) => (
            // Steps are a fixed ordered list per item; the index is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered, never reordered
            <Step key={index} step={step} isAdmin={isAdmin} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The checklist itself, for a view already loaded. `onIgnore`, given to a
 * project admin, offers to hide a profile from AgentDock on the runner (#719).
 */
export function TerminalSetupList({
  view,
  isAdmin,
  onIgnore,
}: {
  view: TerminalSetupView;
  isAdmin: boolean;
  onIgnore?: SetIgnored;
}) {
  return (
    <div className="flex flex-col gap-3">
      {view.complete ? (
        <Banner tone="ok" title="Terminal sessions reach the Board">
          {view.closing}
        </Banner>
      ) : (
        <Banner tone="warn" title={`${stepsLabel(view.todo)} to do`}>
          {view.closing}
        </Banner>
      )}
      <ul className="flex flex-col divide-y divide-line">
        {view.items.map((item) => (
          <Item
            key={`${item.id}:${item.profileKey ?? ''}`}
            item={item}
            isAdmin={isAdmin}
            onIgnore={onIgnore}
          />
        ))}
      </ul>
      {view.otherProfiles.length > 0 ? (
        <section
          className="flex flex-col gap-1"
          aria-label={OTHER_PROFILES_TITLE}
        >
          <h3 className="text-sm font-medium">{OTHER_PROFILES_TITLE}</h3>
          <p className="text-xs text-ink-3">{OTHER_PROFILES_DESCRIPTION}</p>
          <ul className="flex flex-col divide-y divide-line">
            {view.otherProfiles.map((item) => (
              <Item
                key={`${item.id}:${item.profileKey ?? ''}`}
                item={item}
                isAdmin={isAdmin}
                onIgnore={onIgnore}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {view.ignoredProfileKeys.length > 0 ? (
        <section
          className="flex flex-col gap-1"
          aria-label={IGNORED_PROFILES_TITLE}
        >
          <h3 className="text-sm font-medium">{IGNORED_PROFILES_TITLE}</h3>
          <ul className="flex flex-col gap-1">
            {view.ignoredProfileKeys.map((key) => (
              <li key={key} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-words text-sm text-ink-2">
                  {key}
                </span>
                {onIgnore ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onIgnore(key, false)}
                  >
                    Show again
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Settings › Sessions → "Terminal → Board" (issue #281 D6): what the project
 * needs so the work people do in their own terminal reaches its Board, each step
 * with the command or link that does it. Nothing is installed from here (D7).
 */
export function TerminalSetupCard({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const section = useSection(
    () => api<TerminalSetupView>(`/projects/${projectId}/terminal-setup`),
    [projectId],
  );
  const { setData } = section;
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const setIgnored: SetIgnored = async (profileKey, ignored) => {
    setBusy(true);
    try {
      const body: IgnoreTerminalSetupProfileRequest = { profileKey, ignored };
      setData(
        await api<TerminalSetupView>(
          `/projects/${projectId}/terminal-setup/ignored-profiles`,
          { method: 'PUT', body },
        ),
      );
    } catch (err) {
      showError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card pad="lg" className="flex flex-col gap-4">
      <SectionHeader
        title="Terminal → Board"
        description="Work you do in your own terminal reaches this project’s Board once each step below is done."
        actions={
          <Button
            variant="glass"
            size="sm"
            onClick={section.retry}
            disabled={section.loading}
          >
            Check again
          </Button>
        }
      />
      {section.data ? (
        <TerminalSetupList
          view={section.data}
          isAdmin={isAdmin}
          onIgnore={isAdmin && !busy ? setIgnored : undefined}
        />
      ) : section.error !== null ? (
        <Banner tone="danger" title="The checklist could not be loaded">
          {describeError(section.error)}
        </Banner>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </Card>
  );
}
