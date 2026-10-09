'use client';

import type {
  NotificationChannel,
  NotificationRulesView,
} from '@agentdock/shared';
import { Card } from 'glass-ui/card';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { Toggle } from 'glass-ui/toggle';
import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from '../../../lib/api';
import {
  type RuleRow,
  ruleRows,
  ruleUpdate,
} from '../../../lib/notifications/format';

export function RulesSection({ telegramLinked }: { telegramLinked: boolean }) {
  const [view, setView] = useState<NotificationRulesView>();

  const load = useCallback(async () => {
    try {
      setView(await api<NotificationRulesView>('/notifications/rules'));
    } catch (error) {
      toast.error(describeError(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (
    row: RuleRow,
    channel: NotificationChannel,
    value: boolean,
  ) => {
    try {
      setView(
        await api<NotificationRulesView>('/notifications/rules', {
          method: 'PUT',
          body: ruleUpdate(row, channel, value),
        }),
      );
    } catch (error) {
      toast.error(describeError(error));
    }
  };

  const rows = view ? ruleRows(view.rules, telegramLinked) : [];

  return (
    <Card pad="lg">
      <h2 className="mb-1 text-lg font-bold">Rules</h2>
      <p className="text-ink-2 mb-4 text-sm">
        Choose which kinds reach you, and where.
        {telegramLinked ? '' : ' Link Telegram above to enable that column.'}
      </p>
      {view === undefined ? (
        <p className="text-ink-2 text-sm">Loading…</p>
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
                    <span
                      className="inline-flex items-center gap-2 opacity-50"
                      inert
                      title="Link Telegram to turn this on"
                    >
                      <Toggle
                        checked={row.telegram}
                        onChange={() => {}}
                        labelledBy={`rule-${row.kind}-telegram`}
                      />
                      <span className="text-xs">link first</span>
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
