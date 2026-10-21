'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import {
  TOKEN_ECONOMY_SIGNALS,
  type TechniqueMode,
  type TokenEconomyArmReport,
  type TokenEconomyReport,
  type TokenEconomySignal,
  type TokenEconomyTechniqueReport,
} from '@nautelle/shared';
import { useState } from 'react';
import { formatCost, formatNumber } from '../../lib/format';
import {
  dataLabel,
  enableConsequence,
  formatCostInterval,
  formatSignalInterval,
  MODE_LABEL,
  type ShownInterval,
  SIGNAL_HINT,
  SIGNAL_LABEL,
  stopConsequence,
} from '../../lib/token-saver/economy';
import { ResponsiveRows } from '../responsive-rows/responsive-rows';

/** One line of a technique's A-vs-B table. */
interface Measure {
  id: string;
  label: string;
  hint?: string;
  a: ShownInterval;
  b: ShownInterval;
  /** B's interval lies wholly on the worse side of A (#746 `worsens`). */
  worse: boolean;
}

const count = (n: number): ShownInterval => ({
  point: formatNumber(n, 0),
  range: null,
});

const money = (usd: number | null): ShownInterval => ({
  point: usd === null ? '—' : formatCost(usd),
  range: null,
});

const measuresOf = (t: TokenEconomyTechniqueReport): Measure[] => {
  const both = (
    pick: (arm: TokenEconomyArmReport) => ShownInterval,
  ): Pick<Measure, 'a' | 'b'> => ({ a: pick(t.a), b: pick(t.b) });
  return [
    {
      id: 'settled',
      label: 'Settled cards',
      hint: 'Pull request merged or closed, or the card completed.',
      ...both((arm) => count(arm.settledCards)),
      worse: false,
    },
    {
      id: 'merged',
      label: 'Merged cards',
      ...both((arm) => count(arm.mergedCards)),
      worse: false,
    },
    {
      id: 'cost',
      label: '$ per successful card',
      hint: 'The billed cost of every settled card in the arm ÷ its merged cards, so a failed card counts against it.',
      ...both((arm) => formatCostInterval(arm.costPerSuccessUsd)),
      worse: false,
    },
    {
      id: 'median',
      label: 'Median merged card',
      ...both((arm) => money(arm.medianMergedCostUsd)),
      worse: false,
    },
    ...TOKEN_ECONOMY_SIGNALS.map((signal: TokenEconomySignal) => ({
      id: signal,
      label: SIGNAL_LABEL[signal],
      hint: SIGNAL_HINT[signal],
      ...both((arm) => formatSignalInterval(signal, arm.signals[signal])),
      worse: t.worsens.includes(signal),
    })),
  ];
};

const figure = (shown: ShownInterval) => (
  <span className="flex flex-col items-end leading-tight">
    <span className="num">{shown.point}</span>
    {shown.range ? (
      <span className="num text-ink-3 text-xs">{shown.range}</span>
    ) : null}
  </span>
);

function MeasureTable({ technique }: { technique: TokenEconomyTechniqueReport }) {
  return (
    <ResponsiveRows
      label={`${technique.label}: arm A against arm B`}
      rows={measuresOf(technique)}
      getRowId={(m) => m.id}
      columns={[
        {
          id: 'measure',
          header: 'Measure',
          cell: (m: Measure) => (
            <span className="flex flex-wrap items-center gap-2" title={m.hint}>
              {m.label}
              {m.worse ? (
                <Badge tone="warn" size="sm" label="Worse in B" />
              ) : null}
            </span>
          ),
        },
        {
          id: 'a',
          header: 'A · without',
          align: 'end' as const,
          cell: (m: Measure) => figure(m.a),
        },
        {
          id: 'b',
          header: 'B · with',
          align: 'end' as const,
          cell: (m: Measure) => figure(m.b),
        },
      ]}
    />
  );
}

/**
 * #746 "UI": one saving technique under test — its mode, the enough-data
 * marker, arm A against arm B with 95 % intervals, a warning on every signal
 * B worsens and, for a project admin, Enable for all and Stop (D5).
 */
export function TechniqueCard({
  technique,
  minCardsPerArm,
  isAdmin,
  onSetMode,
}: {
  technique: TokenEconomyTechniqueReport;
  minCardsPerArm: number;
  isAdmin: boolean;
  /** Resolves once the mode is saved; a rejection keeps the dialog open. */
  onSetMode: (technique: string, mode: TechniqueMode) => Promise<void>;
}) {
  const [asking, setAsking] = useState<'on' | 'off' | null>(null);
  const [busy, setBusy] = useState(false);
  const t = technique;

  const confirm = async () => {
    if (!asking) return;
    setBusy(true);
    try {
      await onSetMode(t.technique, asking);
      setAsking(null);
    } catch {
      // The caller reported it; the dialog stays open to try again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card pad="md">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{t.label}</h3>
          <Badge tone="neutral" size="sm" label={MODE_LABEL[t.mode]} />
          <Badge
            tone={t.enoughData ? 'ok' : 'neutral'}
            size="sm"
            label={dataLabel(t, minCardsPerArm)}
          />
          {isAdmin ? (
            <span className="ms-auto flex gap-2">
              {t.mode !== 'on' ? (
                <Button
                  variant="glass"
                  size="sm"
                  onClick={() => setAsking('on')}
                >
                  Enable for all
                </Button>
              ) : null}
              {t.mode !== 'off' ? (
                <Button
                  variant="glass"
                  size="sm"
                  onClick={() => setAsking('off')}
                >
                  Stop
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
        {t.worsens.length > 0 ? (
          <Banner tone="warn" title="Arm B is worse on a quality signal">
            {`${t.worsens.map((s) => SIGNAL_LABEL[s]).join(', ')}: B's interval lies wholly on the worse side of A. Consider stopping the technique.`}
          </Banner>
        ) : null}
        <MeasureTable technique={t} />
        {t.b.forcedCards > 0 ? (
          <p className="text-ink-3 text-xs">
            {`${formatNumber(t.b.forcedCards, 0)} of arm B's cards got the technique because it was on for every card, not by the draw.`}
          </p>
        ) : null}
      </div>
      {isAdmin ? (
        <ConfirmDialog
          open={asking !== null}
          onOpenChange={(open) => {
            if (!open) setAsking(null);
          }}
          title={
            asking === 'on'
              ? `Enable ${t.label} for every card?`
              : `Stop ${t.label}?`
          }
          consequence={
            asking === 'on'
              ? enableConsequence(t, minCardsPerArm)
              : stopConsequence(t)
          }
          verb={asking === 'on' ? 'Enable' : 'Stop'}
          tone={asking === 'on' ? 'default' : 'danger'}
          busy={busy}
          onConfirm={() => void confirm()}
        />
      ) : null}
    </Card>
  );
}

/** Every technique of the report, or the line that says none is tested. */
export function TechniquesReport({
  report,
  isAdmin,
  onSetMode,
}: {
  report: TokenEconomyReport;
  isAdmin: boolean;
  onSetMode: (technique: string, mode: TechniqueMode) => Promise<void>;
}) {
  if (report.techniques.length === 0) {
    return (
      <p className="text-ink-3 text-sm">
        No saving technique is under test yet. Each one shows here, arm A
        against arm B, once a runner release adds it.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {report.techniques.map((t) => (
        <TechniqueCard
          key={t.technique}
          technique={t}
          minCardsPerArm={report.minCardsPerArm}
          isAdmin={isAdmin}
          onSetMode={onSetMode}
        />
      ))}
    </div>
  );
}
