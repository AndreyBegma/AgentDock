'use client';

import type {
  NotificationChannel,
  NotificationRulesView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { api, describeError, describeErrorHint } from '../../../lib/api';
import {
  type RuleRow,
  ruleRows,
  ruleSections,
  ruleUpdate,
} from '../../../lib/notifications/format';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';

const LINK_TELEGRAM = (
  <a href="#telegram" className="text-ink underline underline-offset-2">
    Link Telegram
  </a>
);

export function RulesSection({ telegramLinked }: { telegramLinked: boolean }) {
  const rules = useSection(
    () => api<NotificationRulesView>('/notifications/rules'),
    [],
  );
  const showError = useErrorToast();
  const view = rules.data;

  const change = async (
    row: RuleRow,
    channel: NotificationChannel,
    value: boolean,
  ) => {
    try {
      rules.setData(
        await api<NotificationRulesView>('/notifications/rules', {
          method: 'PUT',
          body: ruleUpdate(row, channel, value),
        }),
      );
    } catch (error) {
      showError(describeErrorHint(error));
    }
  };

  const rows = view ? ruleRows(view.rules, telegramLinked) : [];

  return (
    <Card pad="lg">
      <h2 className="mb-1 text-lg font-bold">Rules</h2>
      <p className="text-ink-2 mb-4 text-sm">
        Choose which kinds reach you, and where.
        {telegramLinked ? null : (
          <> {LINK_TELEGRAM} above to turn on the Telegram column.</>
        )}
      </p>
      {view === undefined ? (
        rules.error !== null && !rules.loading ? (
          <SectionUnavailable
            title="Your notification rules could not be loaded"
            stillWorks={`${describeError(rules.error)} Notifications keep arriving with the rules you saved before.`}
            action={
              <Button variant="glass" size="sm" onClick={rules.retry}>
                Try again
              </Button>
            }
          />
        ) : (
          <Skeleton className="h-40 w-full" />
        )
      ) : (
        <div className="flex flex-col gap-6">
          {ruleSections(rows).map((section) => (
            <section
              key={section.group}
              aria-labelledby={`rules-${section.group}`}
            >
              <div className="grid grid-cols-[1fr_4.5rem_4.5rem] items-end gap-x-3 border-b border-line pb-2 sm:grid-cols-[1fr_6rem_6rem]">
                <h3
                  id={`rules-${section.group}`}
                  className="text-sm font-semibold text-ink"
                >
                  {section.label}
                </h3>
                <span className="text-xs text-ink-3">In-app</span>
                <span className="text-xs text-ink-3">Telegram</span>
              </div>
              <ul className="divide-y divide-line">
                {section.rows.map((row) => (
                  <RuleLine
                    key={row.kind}
                    row={row}
                    onChange={(r, channel, value) =>
                      void change(r, channel, value)
                    }
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function RuleLine({
  row,
  onChange,
}: {
  row: RuleRow;
  onChange: (
    row: RuleRow,
    channel: NotificationChannel,
    value: boolean,
  ) => void;
}) {
  return (
    <li className="grid grid-cols-[1fr_4.5rem_4.5rem] items-center gap-x-3 py-3 sm:grid-cols-[1fr_6rem_6rem]">
      <div className="min-w-0" title={`From ${row.source}`}>
        <span id={`rule-${row.kind}`} className="block text-sm">
          {row.label}
        </span>
        <span className="text-ink-3 text-xs">e.g. {row.example}</span>
      </div>
      <div>
        <span id={`rule-${row.kind}-inapp`} className="sr-only">
          {row.label}, in-app
        </span>
        {row.inAppDisabled ? (
          <span className="text-ink-3 text-xs">—</span>
        ) : (
          <Toggle
            checked={row.inApp}
            onChange={(value) => onChange(row, 'inApp', value)}
            labelledBy={`rule-${row.kind}-inapp`}
          />
        )}
      </div>
      <div>
        <span id={`rule-${row.kind}-telegram`} className="sr-only">
          {row.label}, Telegram
        </span>
        {row.telegramNote === 'in-app only' ? (
          <span className="text-ink-3 text-xs" title="In-app only">
            In-app only
          </span>
        ) : row.telegramDisabled ? (
          <span
            className="inline-flex opacity-50"
            inert
            title="Link Telegram first"
          >
            <Toggle
              checked={row.telegram}
              onChange={() => {}}
              labelledBy={`rule-${row.kind}-telegram`}
            />
          </span>
        ) : (
          <Toggle
            checked={row.telegram}
            onChange={(value) => onChange(row, 'telegram', value)}
            labelledBy={`rule-${row.kind}-telegram`}
          />
        )}
      </div>
    </li>
  );
}
