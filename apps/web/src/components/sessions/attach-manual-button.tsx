'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Terminal } from 'lucide-react';
import { useState } from 'react';
import { useTerminalAvailable } from '../../lib/terminal/use-terminal-available';
import { TerminalSheet } from '../terminal/terminal-sheet';

/**
 * Attach to a manual session started by `nautelle-runner claude` (spec 201
 * D23, spec 29). Offered to an admin when the session reported a tmux session
 * and its runner can attach; it opens read-only, like every attach.
 */
export function AttachManualButton({
  projectId,
  sessionId,
  runnerId,
  tmuxSession,
  isAdmin,
  title,
}: {
  projectId: string | null;
  sessionId: string;
  runnerId: string;
  tmuxSession: string | null | undefined;
  isAdmin: boolean;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const available = useTerminalAvailable(runnerId, isAdmin);
  if (!projectId || !tmuxSession || !isAdmin || !available) return null;
  return (
    <>
      <Button variant="glass" size="sm" onClick={() => setOpen(true)}>
        <Terminal aria-hidden="true" className="size-4" />
        Attach
      </Button>
      <TerminalSheet
        projectId={projectId}
        target={open ? { kind: 'manual', sessionId } : undefined}
        title={title}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
