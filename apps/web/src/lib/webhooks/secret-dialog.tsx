'use client';

import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { CodeBlock } from 'glass-ui/code-block';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { toast } from 'glass-ui/toast';
import type { ReactNode } from 'react';

export interface RevealedSecret {
  /** What the dialog is about, e.g. “Trigger created”. */
  title: string;
  secret: string;
  /** Samples that embed the secret (shown only while the dialog is open). */
  children?: ReactNode;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Secret copied.');
  } catch {
    toast.error('Could not copy — select the text and copy it by hand.');
  }
}

/**
 * Shows a secret exactly once (spec 26 D17). It lives only in this
 * component's props: closing the dialog drops it and the API never returns it
 * again, so the caller must not keep it in any other state.
 */
export function SecretDialog({
  revealed,
  onClose,
}: {
  revealed: RevealedSecret | null;
  onClose: () => void;
}) {
  return (
    <DialogRoot
      open={revealed !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {revealed ? (
        <DialogContent
          title={revealed.title}
          description="Copy the secret now. It is shown once and cannot be displayed again — rotate it if it is lost."
          footer={
            <>
              <Button variant="glass" onClick={() => copy(revealed.secret)}>
                Copy secret
              </Button>
              <Button variant="solid" onClick={onClose}>
                Done
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <Banner tone="warn">This is the only time you will see it.</Banner>
            <CodeBlock code={revealed.secret} wrap />
            {revealed.children}
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}
