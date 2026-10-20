'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Textarea } from '@andrewbehma/glass-ui/field';
import {
  PopoverAnchor,
  PopoverContent,
  PopoverRoot,
} from '@andrewbehma/glass-ui/popover';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { DESIGN_COMMENT_MAX } from '@nautelle/shared';
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
  phone = false,
  frameName,
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
  /** Below `lg` (C-244): a bottom sheet in place of the popover, which a 375px screen clips. */
  phone?: boolean;
  /** The frame the pin is on, named in the sheet. */
  frameName?: string | null;
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

  const cancel = () => {
    setBody('');
    onCancel();
  };
  const field = (
    <Textarea
      aria-label={`Comment on pin ${number}`}
      rows={phone ? 3 : 4}
      maxLength={DESIGN_COMMENT_MAX}
      value={body}
      placeholder="What should change here?"
      onChange={(e) => setBody(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
      }}
    />
  );

  if (phone) {
    return (
      <SheetRoot
        open={pin !== null}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <SheetContent
          title={`Pin ${number}`}
          description={`${frameName ? `On frame “${frameName}” · ` : ''}shows at ${screen}.`}
          side="bottom"
          footer={
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-ink-3 tabular-nums">
                {body.length} / {DESIGN_COMMENT_MAX}
              </span>
              <div className="flex gap-2">
                <Button className="h-11" variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
                <Button
                  className="h-11"
                  variant="solid"
                  disabled={!text || busy}
                  onClick={() => void save()}
                >
                  {busy ? 'Saving…' : 'Comment'}
                </Button>
              </div>
            </div>
          }
        >
          {field}
        </SheetContent>
      </SheetRoot>
    );
  }

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
        {field}
      </PopoverContent>
    </PopoverRoot>
  );
}
