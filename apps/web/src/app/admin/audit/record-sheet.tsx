'use client';

import type { AuditRecordView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import type { ReactNode } from 'react';
import { actionLabel, RESULT_LABEL } from '../../../lib/audit/actions';
import {
  actorLabel,
  formatTime,
  prettyJson,
  RESULT_TONE,
} from '../../../lib/audit/format';
import { type NameIndex, targetDisplay } from '../../../lib/audit/targets';

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
  names,
  onClose,
}: {
  record: AuditRecordView | undefined;
  names: NameIndex;
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
          footer={
            <Button variant="glass" onClick={onClose}>
              Close
            </Button>
          }
          title={actionLabel(record.action)}
          description={`${record.action} · record #${record.seq} · ${formatTime(record.ts)}`}
        >
          <dl className="flex flex-col gap-4">
            <Row label="Result">
              <Badge
                tone={RESULT_TONE[record.result]}
                label={RESULT_LABEL[record.result]}
              />
            </Row>
            <Row label="Actor">
              {actorLabel(record, names)}
              {(record.actorUserId ?? record.actorOnBehalfOfId) ? (
                <span className="block font-mono text-xs text-ink-3">
                  {record.actorUserId ?? record.actorOnBehalfOfId}
                </span>
              ) : null}
            </Row>
            <Row label="Target">
              {targetDisplay(record, names).text}
              {record.targetId ? (
                <span className="block font-mono text-xs text-ink-3">
                  {record.targetId}
                </span>
              ) : null}
            </Row>
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
