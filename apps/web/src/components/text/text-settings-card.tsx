'use client';

import { Card } from '@andrewbehma/glass-ui/card';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { useEffect, useState } from 'react';
import { describeBoardError } from '../../lib/board/format';
import { fetchTextSettings, updateTextSettings } from '../../lib/text/actions';

/**
 * Settings › General: "Store text in English" (#271 D13). Members read it,
 * a project admin flips it; it saves at once.
 */
export function TextSettingsCard({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    fetchTextSettings(projectId)
      .then((view) => {
        if (current) setEnabled(view.normalizeEnabled);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [projectId]);

  const change = async (next: boolean) => {
    setBusy(true);
    try {
      const view = await updateTextSettings(projectId, {
        normalizeEnabled: next,
      });
      setEnabled(view.normalizeEnabled);
      toast.success(
        view.normalizeEnabled
          ? 'New text will be stored in English.'
          : 'New text will be stored as typed.',
      );
    } catch (err) {
      toast.error(describeBoardError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card pad="lg" className="flex flex-col gap-2" aria-labelledby="text-store">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 id="text-store" className="text-base font-semibold">
            Store text in English
          </h2>
          <p className="text-ink-3 text-xs">
            Text is translated by a small model on this project’s runner. The
            original stays one click away.
          </p>
        </div>
        {enabled === undefined ? null : isAdmin ? (
          <span inert={busy || undefined} className={busy ? 'opacity-60' : ''}>
            <Toggle
              checked={enabled}
              onChange={(value) => void change(value)}
              labelledBy="text-store"
            />
          </span>
        ) : (
          <span className="text-sm">{enabled ? 'on' : 'off'}</span>
        )}
      </div>
      {isAdmin ? null : (
        <p className="text-ink-3 text-sm">
          Only administrators can change this setting.
        </p>
      )}
    </Card>
  );
}
