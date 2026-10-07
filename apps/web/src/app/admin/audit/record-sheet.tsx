'use client';

import type { AuditRecordView } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import type { ReactNode } from 'react';
import {
  actorLabel,
  formatTime,
  prettyJson,
  RESULT_TONE,
  targetLabel,
} from '../../../lib/audit/format';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      <dd className="break-all text-sm">{children}</dd>
    </div>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <Row label={label}>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-control bg-surface p-3 font-mono text-xs">
        {prettyJson(value)}
      </pre>
    </Row>
  );
}

export function RecordSheet({
  record,
  onClose,
}: {
  record: AuditRecordView | undefined;
  onClose: () => void;
}) {
  return (
    <SheetRoot
      open={record !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {record ? (
        <SheetContent
          side="right"
          title={record.action}
          description={`Record #${record.seq} · ${formatTime(record.ts)}`}
        >
          <dl className="flex flex-col gap-4">
            <Row label="Result">
              <Badge tone={RESULT_TONE[record.result]} label={record.result} />
            </Row>
            <Row label="Actor">
              {actorLabel(record)}
              {record.actorUserId ? (
                <span className="block font-mono text-xs text-ink-3">
                  {record.actorUserId}
                </span>
              ) : null}
            </Row>
            <Row label="Target">{targetLabel(record)}</Row>
            <Row label="Project">{record.projectId ?? '—'}</Row>
            <Json label="Before" value={record.before} />
            <Json label="After" value={record.after} />
            <Json label="Meta" value={record.meta} />
            <Row label="Previous hash">
              <code className="font-mono text-xs">{record.prevHash}</code>
            </Row>
            <Row label="Hash">
              <code className="font-mono text-xs">{record.hash}</code>
            </Row>
          </dl>
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}
