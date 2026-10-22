'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { useState } from 'react';
import { maskUrlPath } from './format';

/**
 * C-177: a URL that is a bearer secret, its path hidden until **Reveal**. The
 * masked form has no copy button, so what is copied is never the mask.
 */
export function MaskedUrlView({
  url,
  revealed,
  onRevealedChange,
}: {
  url: string;
  revealed: boolean;
  onRevealedChange: (revealed: boolean) => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      <CodeBlock
        className="w-full"
        code={revealed ? url : maskUrlPath(url)}
        copy={revealed}
        wrap
      />
      <Button
        variant="glass"
        size="sm"
        onClick={() => onRevealedChange(!revealed)}
      >
        {revealed ? 'Hide' : 'Reveal'}
      </Button>
    </div>
  );
}

/** `MaskedUrlView` that hides the URL again whenever it changes. */
export function MaskedUrl({ url }: { url: string }) {
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  return (
    <MaskedUrlView
      url={url}
      revealed={revealedFor === url}
      onRevealedChange={(revealed) => setRevealedFor(revealed ? url : null)}
    />
  );
}
