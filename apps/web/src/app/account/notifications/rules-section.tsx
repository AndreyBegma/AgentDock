'use client';

import type {
  NotificationChannel,
  NotificationRulesView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { api, describeError, describeErrorHint } from '../../../lib/api';
import {
  type RuleRow,
  ruleRows,
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
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>Kind</TableCell>
              <TableCell head>In-app</TableCell>
              <TableCell head>Telegram</TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {rows.map((row) => (
              <TableRow key={row.kind}>
                <TableCell>
                  <span id={`rule-${row.kind}`} className="block">
                    {row.label}
                  </span>
                  <span className="text-ink-3 text-xs">{row.source}</span>
                </TableCell>
                <TableCell>
                  <span id={`rule-${row.kind}-inapp`} className="sr-only">
                    {row.label}, in-app
                  </span>
                  {row.inAppDisabled ? (
                    <span className="text-ink-3 text-xs">—</span>
                  ) : (
                    <Toggle
                      checked={row.inApp}
                      onChange={(value) => void change(row, 'inApp', value)}
                      labelledBy={`rule-${row.kind}-inapp`}
                    />
                  )}
                </TableCell>
                <TableCell>
                  <span id={`rule-${row.kind}-telegram`} className="sr-only">
                    {row.label}, Telegram
                  </span>
                  {row.telegramNote === 'in-app only' ? (
                    <span className="text-ink-3 text-xs">in-app only</span>
                  ) : row.telegramDisabled ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-flex opacity-50" inert>
                        <Toggle
                          checked={row.telegram}
                          onChange={() => {}}
                          labelledBy={`rule-${row.kind}-telegram`}
                        />
                      </span>
                      <span className="text-xs text-ink-2">
                        {LINK_TELEGRAM} first
                      </span>
                    </span>
                  ) : (
                    <Toggle
                      checked={row.telegram}
                      onChange={(value) => void change(row, 'telegram', value)}
                      labelledBy={`rule-${row.kind}-telegram`}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
