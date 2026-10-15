'use client';

import { DESIGN_COMMENT_MAX } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Textarea } from '@andrewbehma/glass-ui/field';
import {
  PopoverAnchor,
  PopoverContent,
  PopoverRoot,
} from '@andrewbehma/glass-ui/popover';
import { useState } from 'react';
import { anchorAt } from '../../lib/design/zoom';
import type { FramePin } from './mockup-frame';

/**
 * The comment box a pin-mode click opens, at the point (spec 223 "UI"). Its
 * marker is already drawn in the mockup as a draft; Cancel or Escape drops
 * both.
 */
export function PinComposer({
  pin,
  zoom,
  number,
  screen,
  busy,
  onSave,
  onCancel,
}: {
  pin: FramePin | null;
  /** The scale the pin was placed at: `pin.frame` is the scaled box (spec 335 D5). */
  zoom: number;
  /** The number the marker shows. */
  number: number;
  /** "Mobile · dark": where the pin will show. */
  screen: string;
  busy: boolean;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const at = pin ? anchorAt(pin, pin.frame, zoom) : null;
  const text = body.trim();

  const save = async () => {
    if (!text) return;
    try {
      await onSave(text);
      setBody('');
    } catch {
      // Toasted by the caller; the box keeps the text to try again.
    }
  };

  return (
    <PopoverRoot
      open={pin !== null}
      onOpenChange={(open) => {
        if (!open) {
          setBody('');
          onCancel();
        }
      }}
    >
      <PopoverAnchor asChild>
        <div
          aria-hidden="true"
          className="pointer-events-none fixed size-0"
          style={at ?? { left: 0, top: 0 }}
        />
      </PopoverAnchor>
      <PopoverContent
        title={`Pin ${number}`}
        description={`Shows at ${screen}.`}
        side="right"
        align="start"
        className="w-80"
        footer={
          <div className="flex justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setBody('');
                onCancel();
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="glass"
              disabled={!text || busy}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Comment'}
            </Button>
          </div>
        }
      >
        <Textarea
          aria-label={`Comment on pin ${number}`}
          rows={4}
          maxLength={DESIGN_COMMENT_MAX}
          value={body}
          placeholder="What should change here?"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          }}
        />
      </PopoverContent>
    </PopoverRoot>
  );
}
