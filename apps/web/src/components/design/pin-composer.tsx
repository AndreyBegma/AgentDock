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
import type { FramePin } from './mockup-frame';

/**
 * Where the click was, in the page's viewport: the frame's box plus the
 * click's place in the frame. A helper that sends no viewport position (one
 * served before it did) anchors at the frame's top edge instead.
 */
const anchorAt = (pin: FramePin): { left: number; top: number } =>
  pin.clientX !== undefined && pin.clientY !== undefined
    ? { left: pin.frame.left + pin.clientX, top: pin.frame.top + pin.clientY }
    : { left: pin.frame.left + pin.frame.width / 2, top: pin.frame.top };

/**
 * The comment box a pin-mode click opens, at the point (spec 223 "UI"). Its
 * marker is already drawn in the mockup as a draft; Cancel or Escape drops
 * both.
 */
export function PinComposer({
  pin,
  number,
  screen,
  busy,
  onSave,
  onCancel,
}: {
  pin: FramePin | null;
  /** The number the marker shows. */
  number: number;
  /** "Mobile · dark": where the pin will show. */
  screen: string;
  busy: boolean;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const at = pin ? anchorAt(pin) : null;
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
